/**
 * CONTEXT DESK — `run.compose` (DESIGN-COCKPIT-V2.md §3.4).
 *
 * The channel strips of the NEXT turn's composition, SERVED BY THE SAME
 * SINGLE-OWNER FUNCTIONS THE RUN USES — never simulated. The run start path
 * (`server/routes/run.ts`) assembles the model input as:
 *
 *   buildConversationHistory → (compose adjustments, below) →
 *   createRunContextManager + seedContextManagerFromHistory + trim →
 *   buildLLMInput(manager, parts, memories) → estimateHistoryTokens
 *
 * `buildNextTurnComposition` calls EXACTLY that chain (same imports, same
 * owners — context-bridge is the assembly SPO), then decomposes the result
 * into measured channels. The one honest difference from a live run: the
 * next prompt does not exist yet, so the history ends at the last persisted
 * message and memory retrieval is keyed on the LAST user prompt (what a
 * re-send would recall) — both stated in the channel labels, not hidden.
 *
 * CHANNELS SERVED — AND THE ONE THAT IS NOT
 *
 * `system`, `memories`, `history`, `toolResults`, `toolSchemas`. The spec
 * also names a `files` channel; THIS server's assembly has no separate file
 * channel (files reach the model only through tool results), so no `files`
 * strip is emitted and no verb accepts it — an absent channel, not an empty
 * lie. `toolSchemas` IS a real channel of the request: the OpenAI `tools`
 * array rides beside the messages on every call, a per-call constant the
 * provider bills — a "next turn" total that omitted it understated the
 * real per-call cost (the measured UIE-054 defect: a desk reading 16%
 * where the call's true fill was 38%).
 *
 * TWO READS, ONE ASSEMBLY (`run.compose` + `run.composeItem`)
 *
 * `run.compose` serves the STRIPS — a name and a measured token cost per
 * item, which is all a bar needs. It deliberately carries no bodies: the
 * system prompt alone is thousands of characters, and shipping every turn
 * and every tool result on every desk open would make the strips slow to
 * pay for detail nobody has asked to see yet.
 *
 * `run.composeItem` serves ONE item's REAL body — the exact text the model
 * will be handed for it. It does not re-fetch anything: it runs the SAME
 * `assembleComposition` pass the strips come from and returns the body that
 * pass recorded beside the number. A re-fetch (re-reading the message row,
 * re-reading the memory entry) could differ from what is actually sent —
 * unredacted, untrimmed, pre-adjustment — which is precisely the lie a
 * context desk exists to make impossible. One assembly, two projections.
 *
 * Bodies are what `buildLLMInput` produced, so they are already through the
 * redaction gate every LLM-bound string crosses (`buildTrimmedHistory` /
 * `injectMemoriesIntoPrompt` redact); the desk shows what the model sees,
 * not what the database holds. Past `COMPOSE_ITEM_MAX_CHARS` the read states
 * how many characters it withheld — never a silent cut.
 *
 * A block declares ONE read (`defineBlock`), so the per-item detail is a
 * second block rather than a second verb on the first. It is a READ, not an
 * action: making it a POST action to keep one block id would have put a
 * "look at this" behind the mutation path (CSRF, rate limiting, an effect
 * row per glance) and mislabelled inspection as a change.
 *
 * ACTIONS ARE LEDGER-BACKED, HONORED BY THE NEXT ASSEMBLY
 *
 * `pin` / `unpin` / `mute` / `unmute` / `trim` append `context`-type ledger events (document
 * `compose`, carrying the acting user); the per-chat state is the FOLD of
 * those events — no second store. `applyComposeAdjustments` is the single
 * honoring point: the run start path calls it between history-build and
 * manager-seed, and this block's read calls the same function, so the strip
 * you see is the assembly you get. A `mute` expires after `turns` further
 * assemblies (default 1 — "exclude from the next turn"), measured as runs
 * started in the chat after the mute was recorded: deterministic over
 * recorded rows. `pin` is standing (always include) until `unpin` takes it
 * back — a mute only suspends it for its own window. `unmute` takes a mute
 * back the same way (§3.4: no one-way verbs) — the later verb wins, and it
 * does not need a run to have started first.
 */

import { z } from "zod";

import { sha256 } from "../kernel/digest.ts";

import {
  buildLLMInput,
  createRunContextManager,
  estimateHistoryTokens,
  estimateToolSchemasTokens,
  seedContextManagerFromHistory,
  assembleSystemPrompt,
  type RetrievedMemory,
} from "../context/context-bridge.ts";
import { buildConversationHistory } from "../context/chat-history.ts";
import { COMPOSE_FOLD_LIMIT, COMPOSE_ITEM_MAX_CHARS } from "../../shared/constants.ts";
import { COMPOSE_CHANNEL_IDS, type ComposeChannelId } from "../../shared/wire-types.ts";
import { getMemoryRetrievalLimit } from "../kernel/harness-config.ts";
import { getMemoryEntry, memoryRunIds, retrieveRelevantMemories } from "../context/memory-bridge.ts";
import {
  discardedMessageIdsForChat,
  discardedRunIdsForChat,
  planRewind,
  recordRestore,
  recordRewind,
  withdrawnStretchById,
  withdrawnStretchesForChat,
} from "../run/rewind.ts";
import { getEnabledToolManifestForSession, manifestEntriesToToolDefinitions } from "../tools/tools-bridge.ts";
import { readToolSettingsSnapshot } from "../run/run-executor.ts";
import { loadProviderStore, storedContextWindowFor } from "../llm/providers.ts";
import { getTimelineRecorder, getTimelineStore } from "../observability/timeline-bridge.ts";
import { redactContent } from "../llm/redaction.ts";
import { requireUserContext } from "../auth/user-context.ts";
import { NotFoundError } from "../kernel/errors.ts";
import type { ChatMessage } from "../llm/llm-bridge.ts";
import type { AsyncDbClient } from "../db/async-client.ts";
import { defineBlock, type BlockHandlerContext } from "./define.ts";

// ── Ledger encoding ────────────────────────────────────────────────────────

/** No rewind has withdrawn a run here, so no memory needs looking up at all.
 * Frozen and shared so the common case allocates nothing. */
const NO_RUN_IDS: ReadonlyMap<string, string | null> = new Map();

/** Event type compose events ride on (declared registry member). */
const COMPOSE_EVENT_TYPE = "context" as const;
/** Document name carrying the compose payload. */
export const COMPOSE_DOCUMENT = "compose";
// The fold ceiling (`COMPOSE_FOLD_LIMIT`) is owned by shared/constants.ts.

type ComposeDoc = Readonly<{
  op: "pin" | "unpin" | "mute" | "unmute" | "trim";
  chatId: string;
  userId: string;
  channel?: "memories" | "toolResults";
  itemId?: string;
  turns?: number;
  beforeTurn?: number;
}>;

function recordComposeEvent(doc: ComposeDoc): void {
  const contentJson = JSON.stringify(doc);
  getTimelineRecorder().recordEvent({
    eventType: COMPOSE_EVENT_TYPE,
    description: `compose:${doc.op} ${doc.chatId}`,
    outcome: "succeeded",
    documents: [
      {
        name: COMPOSE_DOCUMENT,
        contentJson,
        contentDigest: sha256(contentJson),
      },
    ],
  });
}

function decodeComposeDoc(contentJson: string | undefined): (ComposeDoc & { wallTime?: string }) | undefined {
  if (contentJson === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(contentJson);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const r = parsed as Record<string, unknown>;
  if (typeof r.op !== "string" || typeof r.chatId !== "string" || typeof r.userId !== "string") {
    return undefined;
  }
  return r as unknown as ComposeDoc;
}

// ── Per-chat compose state (the fold) ──────────────────────────────────────

type MuteMark = Readonly<{ turns: number; atWallTime: string }>;

export type ComposeState = Readonly<{
  pinnedMemoryIds: readonly string[];
  /** ACTIVE channel mutes (expiry already applied). */
  mutedChannels: readonly ("memories" | "toolResults")[];
  /** ACTIVE per-memory mutes (expiry already applied). */
  mutedMemoryIds: readonly string[];
  trimBeforeTurn?: number;
}>;

/**
 * Distinct runs started in the chat strictly after `wallTime` — the
 * deterministic assembly counter mute-expiry is measured in. A run's start
 * instant is the `created_at` of its FIRST persisted message.
 */
async function runStartTimes(
  db: AsyncDbClient,
  chatId: string,
  userId: string,
): Promise<readonly string[]> {
  const firstSeen = new Map<string, string>();
  for (const msg of await db.listMessages(chatId, userId)) {
    if (msg.run_id === null || msg.run_id === undefined || msg.run_id === "") continue;
    if (!firstSeen.has(msg.run_id)) firstSeen.set(msg.run_id, msg.created_at);
  }
  return [...firstSeen.values()];
}

/** Fold the chat's compose events (caller-scoped) into the live state. */
export async function composeStateForChat(
  db: AsyncDbClient,
  chatId: string,
  userId: string,
): Promise<ComposeState> {
  const events = getTimelineStore().query({
    eventType: COMPOSE_EVENT_TYPE,
    ascending: true,
    limit: COMPOSE_FOLD_LIMIT,
  });
  const pinned = new Set<string>();
  const channelMutes = new Map<"memories" | "toolResults", MuteMark>();
  const itemMutes = new Map<string, MuteMark>();
  let trimBeforeTurn: number | undefined;
  for (const event of events) {
    if (!event.description.startsWith("compose:")) continue;
    const doc = decodeComposeDoc(event.documents.find((d) => d.name === COMPOSE_DOCUMENT)?.contentJson ?? undefined);
    if (doc === undefined || doc.chatId !== chatId || doc.userId !== userId) continue;
    switch (doc.op) {
      case "pin": {
        if (doc.itemId !== undefined) {
          pinned.add(doc.itemId);
          itemMutes.delete(doc.itemId);
        }
        break;
      }
      case "unpin": {
        // Drops the STANDING include and nothing else: an unpinned memory
        // goes back to being recalled (or not) on its own merits, so any
        // active mute on it is left exactly as it was. The later verb wins,
        // which is the same rule `pin` follows.
        if (doc.itemId !== undefined) pinned.delete(doc.itemId);
        break;
      }
      case "mute": {
        const mark: MuteMark = { turns: doc.turns ?? 1, atWallTime: event.wallTime };
        if (doc.itemId !== undefined) {
          // A pin is NOT cancelled: an active item mute wins while its
          // window lasts, and the standing pin resumes when it expires.
          itemMutes.set(doc.itemId, mark);
        } else if (doc.channel !== undefined) {
          channelMutes.set(doc.channel, mark);
        }
        break;
      }
      case "unmute": {
        // Takes the ACTIVE mute back and nothing else — the same rule
        // `unpin` follows: the later verb wins, an expired mute is already
        // gone (deleting its map entry is a no-op), and a standing pin is
        // left exactly as it was.
        if (doc.itemId !== undefined) {
          itemMutes.delete(doc.itemId);
        } else if (doc.channel !== undefined) {
          channelMutes.delete(doc.channel);
        }
        break;
      }
      case "trim": {
        trimBeforeTurn = doc.beforeTurn;
        break;
      }
    }
  }
  // Mute expiry is measured in runs started since the mute, and the counter
  // is one message read. It is taken ONCE here — every mark on this chat is
  // measured against the same message list — rather than once per mark, and
  // the predicate below stays synchronous because the filters it feeds are.
  const runStarts = await runStartTimes(db, chatId, userId);
  const active = (mark: MuteMark): boolean =>
    runStarts.filter((at) => at > mark.atWallTime).length < mark.turns;
  return Object.freeze({
    pinnedMemoryIds: Object.freeze([...pinned]),
    mutedChannels: Object.freeze([...channelMutes.entries()].filter(([, m]) => active(m)).map(([c]) => c)),
    mutedMemoryIds: Object.freeze([...itemMutes.entries()].filter(([, m]) => active(m)).map(([id]) => id)),
    ...(trimBeforeTurn !== undefined ? { trimBeforeTurn } : {}),
  });
}

// ── The honoring point (shared by the run start path and this block) ───────

export type ComposeAdjusted = Readonly<{
  history: ChatMessage[];
  memories: readonly RetrievedMemory[];
  /**
   * Memories recall (or a pin) reached but an ACTIVE ITEM MUTE is holding
   * out of this composition — in retrieval order. The desk lists these as
   * stated absences (struck, 0 tokens, the unmute verb on them) rather
   * than letting them silently vanish: a mute must never be a silent cut.
   * Not included: channel-muted items (the channel strip itself carries
   * that way back) and withdrawn-run memories (they are not part of this
   * conversation at all — a different absence with a different owner).
   */
  withheldMemories: readonly RetrievedMemory[];
  state: ComposeState;
}>;

/**
 * Apply the chat's recorded compose state to a freshly-built history +
 * retrieved-memory set. THE single honoring point: `POST /api/run/start`
 * calls this between `buildConversationHistory` and the manager seed, and
 * `buildNextTurnComposition` calls the same function — so the desk's strips
 * and the next run's input cannot disagree about what pin/mute/trim mean.
 */
export async function applyComposeAdjustments(
  db: AsyncDbClient,
  args: Readonly<{
    chatId: string;
    userId: string;
    history: readonly ChatMessage[];
    memories: readonly RetrievedMemory[];
  }>,
): Promise<ComposeAdjusted> {
  const state = await composeStateForChat(db, args.chatId, args.userId);
  let history: ChatMessage[] = [...args.history];

  // trim {beforeTurn}: drop everything before the Nth user turn (1-based).
  // Cutting at a user-message boundary can never orphan a tool_calls group
  // (tool results always follow their assistant message, which follows a
  // user turn start). The LAST user message is never dropped.
  if (state.trimBeforeTurn !== undefined && state.trimBeforeTurn > 1) {
    const userIndexes = history
      .map((m, i) => (m.role === "user" ? i : -1))
      .filter((i) => i >= 0);
    if (userIndexes.length > 0) {
      const target = Math.min(state.trimBeforeTurn, userIndexes.length);
      history = history.slice(userIndexes[target - 1]!);
    }
  }

  // mute toolResults: strip tool-role messages AND the tool_calls arrays off
  // assistant messages TOGETHER — the pairing contract is kept by removing
  // both halves, never one.
  if (state.mutedChannels.includes("toolResults")) {
    history = history
      .filter((m) => m.role !== "tool")
      .map((m) => {
        if (m.role === "assistant" && (m as { tool_calls?: unknown }).tool_calls !== undefined) {
          const { tool_calls: _dropped, ...rest } = m as ChatMessage & { tool_calls?: unknown };
          void _dropped;
          return rest as ChatMessage;
        }
        return m;
      });
  }

  // memories: channel mute silences retrieval (pins survive — "always
  // include"); item mutes drop; pins force-include even when retrieval
  // missed them (fetched by id through the memory owner, user-scoped).
  const mutedAll = state.mutedChannels.includes("memories");
  const mutedIds = new Set(state.mutedMemoryIds);
  const pinnedIds = new Set(state.pinnedMemoryIds);
  // ── THE REWIND'S SECOND DOOR ─────────────────────────────────────────────
  // A completed run stores `User: …\nAssistant: …` as a short-term memory,
  // and memory is recalled into the SYSTEM PROMPT. Filtering the conversation
  // history alone therefore did NOT stop a withdrawn answer reaching the
  // model — it came back through here, verbatim, which is one question
  // answered on two paths. A run is withdrawn only when every message it
  // produced is (`server/rewind.ts::planRewind`), so a memory dropped here
  // describes a turn that is no longer part of this conversation at all.
  //
  // A PIN DOES NOT SAVE IT. Pinning says "recall this even when retrieval
  // misses it"; it does not say "keep sending me the turn I took back", and
  // letting it override would leave a way to reach the withdrawn text.
  //
  // ── ONE READ FOR THE WHOLE SET, NOT ONE PER MEMORY ───────────────────────
  // This asked `getMemoryEntry` once per recalled memory, which is bounded by
  // the retrieval limit but is still a per-item read on the desk's hot path —
  // and each one AES-DECRYPTED the memory's whole content to reach `runId`, a
  // field that sits in unencrypted provenance metadata. `memoryRunIds` answers
  // the same question for every id at once and decrypts nothing: measured over
  // a 40-memory recall, 0.636 ms → 0.015 ms per composition read (41.6×).
  //
  // The ids are gathered BEFORE the filter rather than during it, so the read
  // happens once whatever the shape of the fold — including the pinned ids the
  // loop below re-checks, which used to pay the same per-item cost a second
  // time.
  const withdrawnRuns = discardedRunIdsForChat(args.chatId, args.userId);
  const runIdByMemory = withdrawnRuns.size === 0
    ? NO_RUN_IDS
    : memoryRunIds([...args.memories.map((m) => m.id), ...state.pinnedMemoryIds], args.userId);
  const fromWithdrawnRun = (id: string): boolean => {
    const runId = runIdByMemory.get(id);
    return runId !== undefined && runId !== null && withdrawnRuns.has(runId);
  };
  const withheldMemories = args.memories.filter((m) => mutedIds.has(m.id) && !fromWithdrawnRun(m.id));
  let memories = args.memories.filter(
    (m) => !mutedIds.has(m.id) && !fromWithdrawnRun(m.id) && (!mutedAll || pinnedIds.has(m.id)),
  );
  const present = new Set(memories.map((m) => m.id));
  for (const id of state.pinnedMemoryIds) {
    if (present.has(id)) continue;
    if (fromWithdrawnRun(id)) continue; // a withdrawn turn is not re-added by a pin
    const entry = getMemoryEntry(id, args.userId);
    if (entry === null) continue; // pinned memory since deleted — honest absence
    const recalled = {
      id: entry.id,
      content: entry.content,
      tier: entry.tier,
      timestamp: entry.timestamp,
      score: 1,
    };
    // The entry is read BEFORE the mute check: a pinned memory held out by
    // an item mute is exactly one the composition WOULD otherwise serve
    // (the pin force-includes it), so it belongs on the withheld list with
    // its real label — and pinned ids are few, so the read stays bounded.
    if (mutedIds.has(id)) {
      withheldMemories.push(recalled); // an ACTIVE item mute outweighs the pin
      continue;
    }
    memories = [...memories, recalled];
  }
  return Object.freeze({
    history,
    memories,
    withheldMemories: Object.freeze(withheldMemories),
    state,
  });
}

// ── The composition read ───────────────────────────────────────────────────

export type ComposeItem = Readonly<{ id: string; label: string; tokens: number }>;
export type ComposeChannel = Readonly<{
  id: ComposeChannelId;
  tokens: number;
  items: readonly ComposeItem[];
}>;
export type ComposeRead = Readonly<{
  channels: readonly ComposeChannel[];
  limit: number;
  /** The recorded adjustments currently in force (fold of the ledger events). */
  settings: ComposeState;
}>;

// ── Per-item detail (`run.composeItem`) ────────────────────────────────────

/**
 * One span of the REAL text an item contributes to the next turn's model
 * input. `field` says which part of the wire request the text is, because
 * an assistant turn sends its prose and its tool calls as two different
 * fields, and the tool schemas are not a message field at all — they ride
 * the request's own `tools` array — and collapsing any of these would
 * misreport what the model receives.
 */
export type ComposeItemPart = Readonly<{
  role: "system" | "user" | "assistant" | "tool" | "tools";
  field: "content" | "tool_calls" | "schema";
  text: string;
}>;

export type ComposeItemDetail = Readonly<{
  channel: ComposeChannel["id"];
  itemId: string;
  /** The same label the strip shows — one vocabulary, not a second one. */
  label: string;
  /** The same measured cost the strip shows. */
  tokens: number;
  /** Plain words: where this text comes from and when. */
  origin: string;
  /** The body, in send order. Empty with `absence` set = nothing to show. */
  parts: readonly ComposeItemPart[];
  /** Characters withheld by the payload ceiling. 0 = the whole body is here. */
  withheldChars: number;
  /** Why there is no body, when there genuinely is none. */
  absence?: string;
}>;

/** Strips plus the bodies the same pass measured — see the module header. */
type Composition = Readonly<{
  read: ComposeRead;
  details: ReadonlyMap<string, ComposeItemDetail>;
}>;

/** Channel + item id as one map key. NUL cannot occur in either. */
function detailKey(channel: string, itemId: string): string {
  return `${channel}\0${itemId}`;
}

/**
 * Apply the per-item payload ceiling across an item's parts in send order,
 * reporting the exact number of characters left behind. A body is never cut
 * without the count that says so.
 */
function capParts(parts: readonly ComposeItemPart[]): {
  parts: readonly ComposeItemPart[];
  withheldChars: number;
} {
  const kept: ComposeItemPart[] = [];
  let budget = COMPOSE_ITEM_MAX_CHARS;
  let withheldChars = 0;
  for (const part of parts) {
    if (budget <= 0) {
      withheldChars += part.text.length;
      continue;
    }
    if (part.text.length <= budget) {
      kept.push(part);
      budget -= part.text.length;
      continue;
    }
    kept.push(Object.freeze({ ...part, text: part.text.slice(0, budget) }));
    withheldChars += part.text.length - budget;
    budget = 0;
  }
  return { parts: Object.freeze(kept), withheldChars };
}

/** The item id of the system channel's one item, and its engraved name —
 * declared once and consumed by both the strip and its body. */
const SYSTEM_ITEM_ID = "system-prompt";
const SYSTEM_ITEM_LABEL = "system prompt — project context + repository map + preferences";

/** The item id of the tool-schemas channel's one item — the whole `tools`
 * array the request carries, measured as one channel cost. Per-tool rows
 * would restate what the breaker panel already owns (which tools are on);
 * this strip's job is the cost the whole set adds to every call. */
const TOOL_SCHEMAS_ITEM_ID = "tool-schemas";

/** Token estimate of one string, through the same estimator the run reports with. */
function estimateText(content: string): number {
  return estimateHistoryTokens([{ role: "user", content }]);
}

function preview(content: string, max = 48): string {
  const safe = redactContent(content).replace(/\s+/g, " ").trim();
  return safe.length > max ? `${safe.slice(0, max)}…` : safe;
}

/**
 * Assemble the NEXT turn's composition for a chat — the exact single-owner
 * chain the run start path executes (see the module header) — and decompose
 * it into measured channel strips PLUS, per item, the real text that item
 * contributes. Both projections come out of this one pass, which is what
 * makes the number on the strip and the body in the scope the same fact.
 */
async function assembleComposition(
  db: AsyncDbClient,
  args: Readonly<{ chatId: string; userId: string }>,
): Promise<Composition> {
  const { chatId, userId } = args;
  const chat = await db.getChat(chatId, userId);
  if (chat === null) throw new NotFoundError(`Chat ${chatId} not found`);
  const project = await db.getProject(chat.project_id, userId);
  if (project === null) throw new NotFoundError(`Project ${chat.project_id} not found`);

  // 1. History exactly as run/start builds it — with no next prompt yet, so
  //    the placeholder empty user turn the builder appends is removed.
  const raw = await buildConversationHistory(db, { chatId, currentPrompt: "", userId });
  const last = raw[raw.length - 1];
  if (last !== undefined && last.role === "user" && last.content === "") raw.pop();

  // 2. Memory retrieval keyed on the last user prompt (what a re-send would
  //    recall) — the same retriever, limit and user scope as run/start.
  const lastUserPrompt = [...raw].reverse().find((m) => m.role === "user")?.content ?? "";
  const memories =
    typeof lastUserPrompt === "string" && lastUserPrompt.length > 0
      ? retrieveRelevantMemories(lastUserPrompt, getMemoryRetrievalLimit(), userId)
      : [];

  // 3. The honoring point — identical call to the run start path's.
  const adjusted = await applyComposeAdjustments(db, { chatId, userId, history: raw, memories });

  // 4. Manager seed + LLM input — the same owners, same order.
  //
  // There is no `manager.trim()` between the seed and `buildLLMInput`, and
  // there must not be: this preview claims to be the assembly the run
  // performs, and a trim here runs BEFORE the tool manifest below has even
  // been read — so it evicts as if the run were sending no retrieval tool,
  // and the strip reports a smaller assembly than the run makes. Deriving the
  // LLM input prices and trims against the manifest, once, in the owner both
  // paths call.
  //
  // The LIMIT is the chat's own model's when it declares one — read from the
  // same stored document the run start resolves against, so the strip's
  // denominator and the run's trim budget are the same fact. The window is
  // read WITHOUT minting a credential: this preview must compose even while
  // the provider still owes a key, and minting refuses in that state. A
  // model that declared none keeps the harness-wide limit, exactly as the
  // run does.
  const modelWindow = storedContextWindowFor(
    await loadProviderStore(db, userId),
    chat.model_id ?? null,
  );
  const manager = createRunContextManager(modelWindow);
  seedContextManagerFromHistory(manager, adjusted.history);
  // The same reader the run and the executor use, not a retyped copy of it —
  // a preview that reads the tool overrides its own way is a preview of a
  // different run.
  const toolManifest = getEnabledToolManifestForSession(await readToolSettingsSnapshot(db, userId));
  const userPromptPrefs = await db.getUserPromptPrefs(userId);
  const parts = {
    projectName: project.name,
    projectPath: project.path,
    tools: toolManifest,
    userPromptPrefs: userPromptPrefs ?? undefined,
  };
  const llmInput = buildLLMInput(manager, parts, adjusted.memories);

  // ── Decompose into measured strips ──────────────────────────────────────
  // System channel: the prompt WITHOUT the memory section (same assembler,
  // empty memory set); the memories channel carries the measured difference,
  // attributed per entry by successive-inclusion diffs through the SAME
  // injector — so channel tokens sum to the served prompt's tokens exactly.
  const systemWithout = assembleSystemPrompt(parts, []);
  const systemTokens = estimateText(systemWithout);

  // The bodies this pass records beside the numbers (module header).
  const details = new Map<string, ComposeItemDetail>();
  const remember = (
    detail: Omit<ComposeItemDetail, "parts" | "withheldChars"> & {
      parts: readonly ComposeItemPart[];
    },
  ): void => {
    const { parts: capped, withheldChars } = capParts(detail.parts);
    details.set(
      detailKey(detail.channel, detail.itemId),
      Object.freeze({ ...detail, parts: capped, withheldChars }),
    );
  };

  const memoryItems: ComposeItem[] = [];
  let previousPrompt = systemWithout;
  let previousTokens = systemTokens;
  for (let i = 0; i < adjusted.memories.length; i++) {
    const promptWithThis = assembleSystemPrompt(parts, adjusted.memories.slice(0, i + 1));
    const withThis = estimateText(promptWithThis);
    const memory = adjusted.memories[i]!;
    const label = `[${memory.tier}] ${preview(memory.content)}`;
    const tokens = Math.max(0, withThis - previousTokens);
    memoryItems.push(Object.freeze({ id: memory.id, label, tokens }));
    // The body is the exact text this memory ADDS to the system prompt —
    // the same successive-inclusion difference the token number is measured
    // from, so the words and the count describe one act of composition. It
    // is what the injector wrote, not the stored row: the injector redacts
    // and shortens on the way in, and the desk must show the shortened,
    // redacted line the model will actually read.
    const added = promptWithThis.startsWith(previousPrompt)
      ? promptWithThis.slice(previousPrompt.length)
      : promptWithThis;
    remember({
      channel: "memories",
      itemId: memory.id,
      label,
      tokens,
      origin:
        `recalled for the next reply by matching your last message · kept as ${memory.tier} ` +
        `· saved ${memory.timestamp} · match strength ${memory.score}`,
      parts: [Object.freeze({ role: "system", field: "content", text: added.replace(/^\n+/, "") })],
    });
    previousPrompt = promptWithThis;
    previousTokens = withThis;
  }
  const memoriesTokens = estimateText(llmInput.systemPrompt) - systemTokens;

  // ── The held-out tail (stated absence, not a silent cut) ────────────────
  // Memories an ACTIVE ITEM MUTE is withholding (applyComposeAdjustments
  // hands them over in retrieval order). They serve 0 tokens — that number
  // is the truth, and so is the strike-through the client draws on them —
  // but they STAY LISTED, struck, each carrying its unmute verb: the desk
  // states what it withholds, it never makes it vanish (§1.1), and a mute
  // without a visible way back is a one-way verb (§3.4).
  for (const memory of adjusted.withheldMemories) {
    const label = `[${memory.tier}] ${preview(memory.content)}`;
    memoryItems.push(Object.freeze({ id: memory.id, label, tokens: 0 }));
    remember({
      channel: "memories",
      itemId: memory.id,
      label,
      tokens: 0,
      origin:
        `held out by your mute — recall reached it and the mute kept it out of the next reply ` +
        `· kept as ${memory.tier} · saved ${memory.timestamp} · match strength ${memory.score}`,
      parts: [],
      absence: "muted next turn — this memory is not in the next reply; the mute lifts at the next run",
    });
  }

  // History vs tool results: tool-role messages are the TOOL RESULTS strip;
  // everything else (including assistant tool_calls overhead — the call is
  // the assistant's, the result is the tool's) is HISTORY, grouped by turn
  // (a turn starts at each user message; anything before the first user
  // message — the trim summary frame — is the "context frame" item).
  const historyItems: ComposeItem[] = [];
  const toolItems: ComposeItem[] = [];
  let turnNumber = 0;
  let turnTokens = 0;
  let turnParts: ComposeItemPart[] = [];
  let turnLabel = "context frame (summarized prior conversation)";
  const flushTurn = (): void => {
    if (turnTokens > 0 || turnNumber > 0) {
      const id = `turn-${turnNumber}`;
      const label = turnNumber === 0 ? turnLabel : `turn ${turnNumber}: ${turnLabel}`;
      historyItems.push(Object.freeze({ id, label, tokens: turnTokens }));
      remember({
        channel: "history",
        itemId: id,
        label,
        tokens: turnTokens,
        origin:
          turnNumber === 0
            ? "the standing frame this conversation opens with — what the model is told about everything before the turns below"
            : `the messages of this turn, exactly as they go on the wire (${turnParts.length} of them)`,
        parts: turnParts,
      });
    }
    turnTokens = 0;
    turnParts = [];
  };
  /** The tool a result answers, from the call that issued it in THIS input. */
  const toolNameForCall = (callId: string): string | null => {
    for (const m of llmInput.conversationHistory) {
      for (const call of m.tool_calls ?? []) {
        const c = call as { id?: unknown; function?: { name?: unknown } };
        if (c.id === callId && typeof c.function?.name === "string") return c.function.name;
      }
    }
    return null;
  };
  for (const [index, message] of llmInput.conversationHistory.entries()) {
    const tokens = estimateHistoryTokens([message]);
    if (message.role === "tool") {
      const callId = (message as { tool_call_id?: string }).tool_call_id;
      const id = callId ?? `tool-${index}`;
      const label = `tool result${callId !== undefined ? ` (${callId})` : ""}`;
      toolItems.push(Object.freeze({ id, label, tokens }));
      const toolName = callId !== undefined ? toolNameForCall(callId) : null;
      remember({
        channel: "toolResults",
        itemId: id,
        label,
        tokens,
        origin:
          toolName !== null
            ? `what ${toolName} answered when it ran, sent back to the model word for word`
            : "what the tool answered when it ran, sent back to the model word for word — the input no longer names which tool asked",
        parts:
          message.content.length > 0
            ? [Object.freeze({ role: "tool" as const, field: "content" as const, text: message.content })]
            : [],
        ...(message.content.length === 0
          ? { absence: "this result went out empty — there is no text to show" }
          : {}),
      });
      continue;
    }
    if (message.role === "user") {
      flushTurn();
      turnNumber += 1;
      turnLabel = typeof message.content === "string" ? preview(message.content) : "";
    }
    turnTokens += tokens;
    // An assistant turn can carry prose AND tool calls, in two separate wire
    // fields. Both are sent, so both are shown — and each says which it is.
    if (message.content.length > 0) {
      turnParts.push(
        Object.freeze({ role: message.role as ComposeItemPart["role"], field: "content", text: message.content }),
      );
    }
    if (message.tool_calls !== undefined && message.tool_calls.length > 0) {
      turnParts.push(
        Object.freeze({
          role: message.role as ComposeItemPart["role"],
          field: "tool_calls",
          text: JSON.stringify(message.tool_calls, null, 2),
        }),
      );
    }
  }
  flushTurn();

  remember({
    channel: "system",
    itemId: SYSTEM_ITEM_ID,
    label: SYSTEM_ITEM_LABEL,
    tokens: systemTokens,
    origin:
      "built for this project on every reply — your own standing instructions, the repository map and your saved preferences",
    parts: [Object.freeze({ role: "system", field: "content", text: systemWithout })],
  });

  // ── Tool schemas: the request's `tools` array, a per-call constant ────
  // The run sends the definitions beside the messages on EVERY call
  // (buildChatOpts), derived from the same manifest this preview read —
  // through the SAME sole owner of the manifest→wire mapping
  // (`manifestEntriesToToolDefinitions`) the executor uses, never a
  // restated shape. A composition that omitted this channel would answer
  // "what does the next turn send?" with the messages alone, understating
  // the real per-call cost by a constant the provider always bills
  // (measured ~6.8k tokens for 46 schemas — more than every message
  // channel combined on a fresh chat).
  const toolSchemaDefinitions = manifestEntriesToToolDefinitions(toolManifest);
  const toolSchemasTokens = estimateToolSchemasTokens(toolSchemaDefinitions);
  const toolSchemasLabel = `tool schemas (${toolManifest.length} tools) — every enabled tool's JSON schema, sent with each request`;
  remember({
    channel: "toolSchemas",
    itemId: TOOL_SCHEMAS_ITEM_ID,
    label: toolSchemasLabel,
    tokens: toolSchemasTokens,
    origin:
      `the OpenAI JSON schemas for the ${toolManifest.length} tools the next reply can call — carried beside the ` +
      `messages on every request; the breaker panel's rows decide which tools these are`,
    ...(toolSchemaDefinitions.length > 0
      ? {
          parts: [
            Object.freeze({
              role: "tools" as const,
              field: "schema" as const,
              text: JSON.stringify(toolSchemaDefinitions, null, 2),
            }),
          ],
        }
      : {
          parts: [],
          absence: "no tools are enabled for this reply — the request carries no schemas",
        }),
  });

  const channels: ComposeChannel[] = [
    Object.freeze({
      id: "system" as const,
      tokens: systemTokens,
      items: Object.freeze([
        Object.freeze({ id: SYSTEM_ITEM_ID, label: SYSTEM_ITEM_LABEL, tokens: systemTokens }),
      ]),
    }),
    Object.freeze({
      id: "memories" as const,
      tokens: memoriesTokens,
      items: Object.freeze(memoryItems),
    }),
    Object.freeze({
      id: "history" as const,
      tokens: historyItems.reduce((sum, item) => sum + item.tokens, 0),
      items: Object.freeze(historyItems),
    }),
    Object.freeze({
      id: "toolResults" as const,
      tokens: toolItems.reduce((sum, item) => sum + item.tokens, 0),
      items: Object.freeze(toolItems),
    }),
    Object.freeze({
      id: "toolSchemas" as const,
      tokens: toolSchemasTokens,
      items: Object.freeze([
        Object.freeze({ id: TOOL_SCHEMAS_ITEM_ID, label: toolSchemasLabel, tokens: toolSchemasTokens }),
      ]),
    }),
  ];
  return Object.freeze({
    read: Object.freeze({
      channels: Object.freeze(channels),
      limit: manager.tokenLimit(),
      settings: adjusted.state,
    }),
    details,
  });
}

/** The strips: `run.compose`'s projection of the one assembly. */
export async function buildNextTurnComposition(
  db: AsyncDbClient,
  args: Readonly<{ chatId: string; userId: string }>,
): Promise<ComposeRead> {
  return (await assembleComposition(db, args)).read;
}

/**
 * One item's REAL body: `run.composeItem`'s projection of the SAME assembly.
 *
 * Throws `NotFoundError` when the chat is not this user's (the assembly
 * refuses first, so ownership is enforced by the same check the strips use)
 * or when the channel/item is not part of the next turn — an item that is
 * not being sent has no body to show, and saying so is the honest answer.
 */
export async function composeItemDetail(
  db: AsyncDbClient,
  args: Readonly<{ chatId: string; userId: string; channel: string; itemId: string }>,
): Promise<ComposeItemDetail> {
  const { details } = await assembleComposition(db, { chatId: args.chatId, userId: args.userId });
  const detail = details.get(detailKey(args.channel, args.itemId));
  if (detail === undefined) {
    throw new NotFoundError(
      `nothing named "${args.itemId}" is in the ${args.channel} of this chat's next reply`,
    );
  }
  return detail;
}

// ── Registration ───────────────────────────────────────────────────────────

const ReadInput = z.strictObject({
  chatId: z.string().min(1).max(256),
});

/** Deny-by-default: the channel must be one this assembly actually emits
 * (a `files` channel does not exist here, so it is refused at the door
 * rather than answered with an empty body), and the id is bounded. */
const ItemReadInput = z.strictObject({
  chatId: z.string().min(1).max(256),
  channel: z.enum(COMPOSE_CHANNEL_IDS),
  itemId: z.string().min(1).max(256),
});


const PinInput = z.strictObject({
  channel: z.literal("memories"),
  itemId: z.string().min(1).max(256),
});

const MuteInput = z
  .strictObject({
    channel: z.enum(["memories", "toolResults"]),
    itemId: z.string().min(1).max(256).optional(),
    turns: z.number().int().min(1).max(20).optional(),
  })
  .refine((v) => v.itemId === undefined || v.channel === "memories", {
    message: "itemId is only valid for the memories channel",
  });

/** `unmute` targets the same shape `mute` wrote — no `turns`: a window is a
 * property of the mute being lifted, not of the verb lifting it. */
const UnmuteInput = z
  .strictObject({
    channel: z.enum(["memories", "toolResults"]),
    itemId: z.string().min(1).max(256).optional(),
  })
  .refine((v) => v.itemId === undefined || v.channel === "memories", {
    message: "itemId is only valid for the memories channel",
  });

const TrimInput = z.strictObject({
  beforeTurn: z.number().int().min(1).max(10_000),
});

/**
 * `rewind` — the ONE door for retry, edit & resend, and rewind here.
 *
 * `toMessageId` is the beat the reader is standing on; `mode` says how the
 * anchor is derived from it (see `server/rewind.ts::RewindMode`). Resolving
 * the causing prompt on THIS side is what lets `retry` work when that prompt
 * lives in a history page the browser never loaded.
 */
const RewindInput = z.strictObject({
  toMessageId: z.string().min(1).max(256),
  mode: z.enum(["at", "causing-prompt"]),
});

/**
 * `restore` — undoing an undo, which must always be possible.
 *
 * Named by the rewind's own EVENT ID rather than by a list of messages: the
 * ids come from the record, so this door can only put back exactly what one
 * recorded withdrawal took, and never be used to un-withdraw something it
 * did not.
 */
const RestoreInput = z.strictObject({
  eventId: z.string().min(1).max(256),
});

const ActionScope = z.strictObject({ chatId: z.string().min(1).max(256) });

export function defineComposeBlocks(db: AsyncDbClient): void {
  defineBlock({
    id: "run.composeItem",
    title: "One piece of the next reply's context",
    description:
      "The real text of a single item on the context desk — the words themselves, exactly as the next reply will carry them, with the same measured cost the strip shows and a plain statement of where they come from. Computed by the same assembly that builds the reply, never re-read from storage, so what is shown here cannot differ from what is sent. Past a size ceiling the answer states how many characters it held back.",
    read: {
      input: ItemReadInput,
      output: z.object({
        channel: z.string(),
        itemId: z.string(),
        label: z.string(),
        tokens: z.number(),
        origin: z.string(),
        parts: z.array(z.object({}).loose()),
        withheldChars: z.number(),
        absence: z.string().optional(),
      }),
      // Same lifetime and same invalidation events as the strips: the body
      // and the number it explains must never be two different vintages.
      ttlMs: 5_000,
      invalidateOn: ["run:done", "compose:changed"],
      handler: async (input, { ctx }: BlockHandlerContext): Promise<ComposeItemDetail> => {
        const user = await requireUserContext(ctx, db);
        return composeItemDetail(db, {
          chatId: input.chatId,
          userId: user.userId,
          channel: input.channel,
          itemId: input.itemId,
        });
      },
    },
  });

  defineBlock({
    id: "run.withdrawn",
    title: "Turns you took back",
    description:
      "Every stretch of this conversation you have taken back, newest first — when you did it, which message it started at, how many turns went with it, and whether you have since brought it back. Nothing was deleted to make this list: the turns are still saved, still shown flagged in the conversation, and the `restore` action puts any stretch back into what the model sees.",
    read: {
      input: ActionScope,
      output: z.object({ stretches: z.array(z.object({}).loose()) }),
      ttlMs: 5_000,
      invalidateOn: ["compose:changed", "chat:changed"],
      handler: async (input, { ctx }: BlockHandlerContext) => {
        const user = await requireUserContext(ctx, db);
        if (await db.getChat(input.chatId, user.userId) === null) {
          throw new NotFoundError(`Chat ${input.chatId} not found`);
        }
        // The turns' own words come from the history routes, which serve
        // withdrawn rows flagged. Repeating them here would be a second copy
        // of the transcript that could disagree with the first.
        return Object.freeze({
          stretches: withdrawnStretchesForChat(input.chatId, user.userId),
        });
      },
    },
  });

  defineBlock({
    id: "run.compose",
    title: "Next-turn composition",
    description:
      "Channel strips of the NEXT turn's model input for a chat — system prompt, recalled memories, trimmed history, tool results and the tool schemas the request carries beside them, each with measured token cost — computed by the same single-owner assembly functions the run uses (served, not simulated). No `files` channel exists in this assembly, so none is emitted.",
    read: {
      input: ReadInput,
      output: z.object({
        channels: z.array(z.object({}).loose()),
        limit: z.number(),
        settings: z.object({}).loose(),
      }),
      ttlMs: 5_000,
      invalidateOn: ["run:done", "compose:changed"],
      handler: async (input, { ctx }: BlockHandlerContext): Promise<ComposeRead> => {
        const user = await requireUserContext(ctx, db);
        return buildNextTurnComposition(db, { chatId: input.chatId, userId: user.userId });
      },
    },
    actions: {
      pin: {
        input: ActionScope.extend(PinInput.shape),
        title: "Pin",
        consequence:
          "Always include this memory in what the model sees for this chat, starting with the next reply, even when recall would miss it.",
        invalidates: ["compose:changed"],
        handler: async (input, { ctx }: BlockHandlerContext) => {
          const user = await requireUserContext(ctx, db);
          if (await db.getChat(input.chatId, user.userId) === null) {
            throw new NotFoundError(`Chat ${input.chatId} not found`);
          }
          if (getMemoryEntry(input.itemId, user.userId) === null) {
            throw new NotFoundError(`Memory ${input.itemId} not found`);
          }
          recordComposeEvent({
            op: "pin",
            chatId: input.chatId,
            userId: user.userId,
            channel: input.channel,
            itemId: input.itemId,
          });
          return Object.freeze({ pinned: true, channel: input.channel, itemId: input.itemId });
        },
      },
      unpin: {
        input: ActionScope.extend(PinInput.shape),
        title: "Unpin",
        consequence:
          "Stops always including this memory in what the model sees for this chat, from the next reply on; it can still be recalled on its own.",
        invalidates: ["compose:changed"],
        handler: async (input, { ctx }: BlockHandlerContext) => {
          const user = await requireUserContext(ctx, db);
          if (await db.getChat(input.chatId, user.userId) === null) {
            throw new NotFoundError(`Chat ${input.chatId} not found`);
          }
          // Deliberately NOT gated on the memory still existing (`pin` is):
          // a pin whose memory was since deleted is exactly the pin a user
          // most needs to take back, and refusing would strand it forever.
          recordComposeEvent({
            op: "unpin",
            chatId: input.chatId,
            userId: user.userId,
            channel: input.channel,
            itemId: input.itemId,
          });
          return Object.freeze({ pinned: false, channel: input.channel, itemId: input.itemId });
        },
      },
      mute: {
        input: ActionScope.extend(MuteInput.shape),
        title: "Mute",
        consequence:
          "Leaves this out of what the model sees for the next reply — or the next few, if you say how many; pinned items stay included.",
        invalidates: ["compose:changed"],
        handler: async (input, { ctx }: BlockHandlerContext) => {
          const user = await requireUserContext(ctx, db);
          if (await db.getChat(input.chatId, user.userId) === null) {
            throw new NotFoundError(`Chat ${input.chatId} not found`);
          }
          recordComposeEvent({
            op: "mute",
            chatId: input.chatId,
            userId: user.userId,
            channel: input.channel,
            ...(input.itemId !== undefined ? { itemId: input.itemId } : {}),
            turns: input.turns ?? 1,
          });
          return Object.freeze({
            muted: true,
            channel: input.channel,
            ...(input.itemId !== undefined ? { itemId: input.itemId } : {}),
            turns: input.turns ?? 1,
          });
        },
      },
      unmute: {
        input: ActionScope.extend(UnmuteInput.shape),
        title: "Unmute",
        consequence:
          "Puts this back into what the model sees for the next reply; the mute it lifts would have expired at the next run anyway.",
        invalidates: ["compose:changed"],
        handler: async (input, { ctx }: BlockHandlerContext) => {
          const user = await requireUserContext(ctx, db);
          if (await db.getChat(input.chatId, user.userId) === null) {
            throw new NotFoundError(`Chat ${input.chatId} not found`);
          }
          // Deliberately NOT gated on a mute being active (`mute` is not):
          // unmute targets the fold's own state, so a mute that already
          // expired is a no-op rather than an error — the same idempotence
          // `unpin` has when nothing is pinned.
          recordComposeEvent({
            op: "unmute",
            chatId: input.chatId,
            userId: user.userId,
            channel: input.channel,
            ...(input.itemId !== undefined ? { itemId: input.itemId } : {}),
          });
          return Object.freeze({
            muted: false,
            channel: input.channel,
            ...(input.itemId !== undefined ? { itemId: input.itemId } : {}),
          });
        },
      },
      trim: {
        input: ActionScope.extend(TrimInput.shape),
        title: "Set trim point",
        consequence:
          "From the next reply on, the model no longer sees conversation before this turn; the saved conversation itself is untouched.",
        invalidates: ["compose:changed"],
        handler: async (input, { ctx }: BlockHandlerContext) => {
          const user = await requireUserContext(ctx, db);
          if (await db.getChat(input.chatId, user.userId) === null) {
            throw new NotFoundError(`Chat ${input.chatId} not found`);
          }
          recordComposeEvent({
            op: "trim",
            chatId: input.chatId,
            userId: user.userId,
            beforeTurn: input.beforeTurn,
          });
          return Object.freeze({ trimmed: true, beforeTurn: input.beforeTurn });
        },
      },
      restore: {
        input: ActionScope.extend(RestoreInput.shape),
        title: "Restore from here",
        consequence:
          "Puts the turns you took back into the conversation the model sees again, from the next reply on; the fact that you took them back stays in the record.",
        invalidates: ["compose:changed", "chat:changed"],
        handler: async (input, { ctx }: BlockHandlerContext) => {
          const user = await requireUserContext(ctx, db);
          if (await db.getChat(input.chatId, user.userId) === null) {
            throw new NotFoundError(`Chat ${input.chatId} not found`);
          }
          // Read from the record, in the caller's own scope. A withdrawal
          // recorded in another conversation, or by another user, is simply
          // not found here — the same silence every other read keeps, so this
          // door cannot be used to discover that one exists.
          const stretch = withdrawnStretchById(input.chatId, user.userId, input.eventId);
          if (stretch === null) {
            throw new NotFoundError(
              `No withdrawal ${input.eventId} recorded in chat ${input.chatId}`,
            );
          }
          if (stretch.restored) {
            // Refused rather than appending a second reversal. A restore that
            // "succeeded" twice would put two reversals in the ledger for one
            // withdrawal, and a reader counting them would be told the turns
            // came back twice.
            throw new NotFoundError(
              `Withdrawal ${input.eventId} has already been brought back`,
            );
          }
          const eventId = recordRestore(input.chatId, user.userId, stretch);
          // THE PAIR READS HONESTLY FOREVER. The withdrawal's own event row
          // said the stretch was taken back and offered the door; a restore
          // that left no row in the transcript would make that offer stand
          // beside turns the reader can see are back — a record whose last
          // word about the region is a state it is no longer in. The
          // reversal appends its own inline event row (the same append-only
          // law the ledger obeys): the transcript holds BOTH facts, and a
          // reloaded reader sees the whole sequence — taken back, brought
          // back — without having to have been there.
          await db.createMessage(
            {
              chat_id: input.chatId,
              role: "event",
              content:
                `${String(stretch.messageIds.length)} messages brought back — ` +
                "the withdrawal stays in the record",
              metadata: { eventKind: "restore", timelineEventId: eventId },
            },
            user.userId,
          );
          return Object.freeze({
            eventId,
            restoredEventId: stretch.eventId,
            restoredMessageIds: stretch.messageIds,
            restored: stretch.messageIds.length,
          });
        },
      },
      rewind: {
        input: ActionScope.extend(RewindInput.shape),
        title: "Rewind here",
        consequence:
          "Withdraws this turn and everything after it, so the model no longer sees them; the conversation is kept and the rewind is recorded.",
        // `chat:changed` so the flow reloads the corrected history, and
        // `compose:changed` so the desk's strips re-measure — the two
        // surfaces that are now describing a different conversation.
        invalidates: ["compose:changed", "chat:changed"],
        handler: async (input, { ctx }: BlockHandlerContext) => {
          const user = await requireUserContext(ctx, db);
          if (await db.getChat(input.chatId, user.userId) === null) {
            throw new NotFoundError(`Chat ${input.chatId} not found`);
          }
          // The chat's declared order, user-scoped — the same read and the
          // same total order the history cursor pages through, so the plan
          // is made over the whole conversation and NOT over whatever
          // fraction of it a browser happens to be holding.
          const messages = await db.listMessages(input.chatId, user.userId);
          const already = discardedMessageIdsForChat(input.chatId, user.userId);
          const plan = planRewind(messages, input.toMessageId, input.mode, already);
          if (plan === null) {
            throw new NotFoundError(
              input.mode === "causing-prompt"
                ? `No prompt recorded before message ${input.toMessageId} in chat ${input.chatId}`
                : `Message ${input.toMessageId} not found in chat ${input.chatId}`,
            );
          }
          // Recorded FIRST, and a throw here is allowed to escape: no row is
          // being destroyed, so the event IS the rewind. Reporting success
          // for a rewind the ledger never took would be the hole this whole
          // design exists to close.
          const eventId = recordRewind({
            chatId: input.chatId,
            userId: user.userId,
            anchorMessageId: plan.anchorMessageId,
            discardedMessageIds: plan.discardedMessageIds,
            discardedRunIds: plan.discardedRunIds,
            mode: input.mode,
          });
          // THE WITHDRAWN REGION STAYS VISIBLE AS ITSELF. The client reloads
          // the corrected history on `chat:changed`, and without a persisted
          // row the reload rendered a VOID — a rewound chat was
          // indistinguishable from a brand-new one, one click had silently
          // eaten 165 messages, and the reader had no door back. This row is
          // the region's own honest surface: an inline `rewind` event naming
          // the MEASURED count, carrying the withdrawal's ledger address in
          // its metadata (the `timelineEventId` every event row already
          // carries) so the flow can render the beat AND mint its `restore
          // from here` verb against the exact recorded withdrawal. The same
          // message-row shape the steering and gate-block events persist, so
          // it survives every reload through the one history path.
          await db.createMessage(
            {
              chat_id: input.chatId,
              role: "event",
              content:
                `${String(plan.discardedMessageIds.length)} messages taken back from here — ` +
                "the record keeps them; restore from here brings them back",
              metadata: { eventKind: "rewind", timelineEventId: eventId },
            },
            user.userId,
          );
          return Object.freeze({
            eventId,
            anchorMessageId: plan.anchorMessageId,
            discardedMessageIds: plan.discardedMessageIds,
            discardedRunIds: plan.discardedRunIds,
            discarded: plan.discardedMessageIds.length,
            // The prompt a re-run should send, resolved from the record. The
            // client re-sends THIS rather than a string it carried, so the
            // re-run cannot drift from what was actually recorded.
            promptForRerun: plan.promptForRerun,
          });
        },
      },
    },
  });
}
