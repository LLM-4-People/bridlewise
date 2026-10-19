/**
 * Unified context manager — progressive context + C09+summary trim.
 *
 * Combines:
 * Progressive trim (from candidate context-manager.ts): trim older
 * unpinned turns into a `ContextSummary` when context exceeds the
 * threshold (80% of token limit). Recent turns + pinned kept.
 * C09+summary (from EXP435): deterministic hierarchical conversation
 * summary ALWAYS in context (~200 tokens). Recent-first truncation.
 * The conversation summary is rebuilt every turn and replaces the
 * previous summary (not accumulated).
 *
 * Per `progressiveContextAndCompaction` invariant:
 * "mandatory-facts-and-authored-intent-preserved-optional-material-
 * retrievable-no-forked-agent-views".
 */
import { deepFreeze, generateId } from "../../kernel/integrity.ts";
import { ConversationSummary } from "./conversation-summary.ts";
import { estimateTokens } from "./tokenizer.ts";
import type { UnifiedConfig } from "./unified-config.ts";
import { abridgedReference, type RetrievalRoute, type ToolResultEntry, type ToolResultStore } from "./unified-tool-result-store.ts";
import { InputError } from "../../kernel/errors.ts";
import { extractFirstSentence, contextRemoveTurn, contextGetTurn, contextReplaceTurns, contextIsOverThreshold, contextShouldTrim } from "../context-helpers.ts";
import { dependencySpans } from "../../shared/dependency-spans.ts";
import { projectToolCallArguments } from "../../shared/llm/response-transcript.ts";

export type ContextRole = "system" | "user" | "assistant" | "retrieved" | "summary" | "tool" | "proactive" | "memory";

/** A harness function invocation. The memory owner stores it without depending
 * on the transport; the injected delivery projection decides its wire form. */
export type ContextToolCall = Readonly<{
  id: string;
  type: "function";
  function: Readonly<{ name: string; arguments: string }>;
}>;

export interface ContextTurn {
  readonly turnId: string;
  readonly role: ContextRole;
  readonly content: string;
  /** Isolated-turn estimate for selection. Total charge serializes the complete
   * bound projection, including framing and cross-turn delivery metadata. */
  readonly tokenEstimate: number;
  readonly timestamp: string;
  readonly pinned: boolean;
  readonly sourceEventId: string | null;
  readonly turnNumber: number;
  /** Domain function invocations, retained atomically with their result spans. */
  readonly toolCalls?: readonly ContextToolCall[];
  /** The tool_call_id this turn answers. Present only on `tool` role turns
   * (the result of an assistant tool_calls request). */
  readonly toolCallId?: string;
  /** Opaque delivery evidence; interpreted only by the injected projection. */
  readonly responseItems?: readonly unknown[];
  readonly responseReplayBlocked?: boolean;
}

export interface ContextSummary {
  readonly summaryId: string;
  readonly turnIds: readonly string[];
  readonly content: string;
  readonly tokenEstimate: number;
  readonly createdAt: string;
  readonly sourceTurns: number;
}

export interface ContextState {
  readonly turns: readonly ContextTurn[];
  readonly summaries: readonly ContextSummary[];
  readonly conversationSummaryBlock: string;
  readonly totalTokens: number;
  readonly tokenLimit: number;
  readonly trimThreshold: number;
  readonly trimmed: boolean;
  readonly lastTrimmedTurnId: string | null;
  readonly trimCount: number;
}

export interface UnifiedContextManager {
  readonly config: UnifiedConfig;
  readonly conversationSummary: ConversationSummary;
  /**
   * The store holding the full text of any tool-call payload large enough to
   * be sent abridged, or `null` when no store was supplied (nothing is
   * abridged then, and everything is sent whole — the previous behaviour).
   *
   * Exposed so the layer that MATERIALISES the outbound messages asks this
   * manager's store rather than keeping one of its own. Two stores would be
   * two answers to "what is the full text behind this id", and the one the
   * model was handed would be the wrong one half the time.
   */
  readonly toolResultStore: ToolResultStore | null;
  /**
   * THE BYTES THIS TOOL CALL CONTRIBUTES TO THE OUTBOUND REQUEST.
   *
   * There is exactly one of these, and the token charge is
   * `estimateTokens` OF THIS STRING — not of a form the manager guessed the
   * emitter would choose. The emitter calls this and sends what it returns.
   * A charge that disagrees with the payload has no way to exist, because
   * there is only one value and both readers read it.
   *
   * The predecessor of this method handed back the abridgement and let the
   * emitter decide separately whether to use it. The emitter's decision
   * depended on a flag the manager never saw, so with retrieval unavailable
   * the manager charged 249 tokens for 56,181 tokens of payload — a 226x
   * under-charge that switched the trim off entirely and let the request
   * grow to 3.43x the token limit.
   */
  outboundToolCallArguments(toolCall: ContextToolCall): string;
  /**
   * Record whether this run can honour a way back to an abridged payload, as
   * a `RetrievalRoute` read from the manifest the run is SENDING — `null`
   * when it is not sending one.
   *
   * Deny by default: a manager nobody has told sends every payload whole,
   * which is the expensive answer and never the dishonest one, and which is
   * also the answer its charge already reflects.
   *
   * Setting this re-derives the charge of every turn holding tool calls,
   * because the charge is defined as the weight of what would be sent and
   * this is the only thing that can change what would be sent. Invalidation
   * lives with the thing that invalidates rather than with a caller who has
   * to remember.
   */
  setRetrievalRoute(route: RetrievalRoute | null): void;
  addTurn(input: AddTurnInput): ContextTurn;
  /** Replace one captured turn without changing its identity, chronology or retention. */
  updateTurn(turnId: string, input: AddTurnInput): ContextTurn;
  /** Bind the delivery policy before capture; a populated manager cannot change policies. */
  bindProjection<T>(projection: ContextProjection<T>): void;
  /** Derive output using the bound policy, including retained readiness evidence. */
  project<T>(projection: ContextProjection<T>): T;
  pinTurn(turnId: string): boolean;
  unpinTurn(turnId: string): boolean;
  removeTurn(turnId: string): boolean;
  getTurn(turnId: string): ContextTurn | null;
  turns(): readonly ContextTurn[];
  summaries(): readonly ContextSummary[];
  recordSummaryTurn(turn: number, userMessage: string, assistantMessage: string): void;
  setMainTopic(topic: string): void;
  tokenCount(): number;
  tokenLimit(): number;
  trimThreshold(): number;
  trimThresholdTokens(): number;
  isOverThreshold(): boolean;
  shouldTrim(): boolean;
  trim(): ContextState;
  state(): ContextState;
  clear(): void;
  replaceTurns(turns: readonly ContextTurn[]): void;
}

export type AddTurnInput = Readonly<{
  turnId?: string;
  role: ContextRole;
  content: string;
  /** Optional — auto-assigned (monotonic, never reset across trims) when
   * omitted. Callers that track their own turn counter may pass it. */
  turnNumber?: number;
  timestamp?: string;
  pinned?: boolean;
  sourceEventId?: string;
  toolCalls?: readonly ContextToolCall[];
  toolCallId?: string;
  responseItems?: readonly unknown[];
  responseReplayBlocked?: boolean;
}>;

/** The memory owner supplies data and transforms; the delivery owner interprets it. */
export type ContextProjectionInput = Readonly<{
  turns: readonly ContextTurn[];
  summaries: readonly string[];
  argumentsOf: (call: ContextToolCall) => string;
  contentOf: (content: string) => string;
}>;
export type ContextProjection<T> = Readonly<{
  project(input: ContextProjectionInput): T;
  serialize(output: T): string;
  references(turn: ContextTurn): readonly string[];
  assertReady(turns: readonly ContextTurn[]): void;
}>;

// Domain-only memory consumers use a domain serialization. Provider-bound hosts
// explicitly bind their protocol projection before adding any history.
const DOMAIN_PROJECTION: ContextProjection<unknown> = {
  project: ({ turns, summaries, argumentsOf, contentOf }) => ({ summaries: summaries.map(contentOf),
    turns: turns.map(turn => ({ role: turn.role, content: contentOf(turn.content),
      ...(turn.toolCalls ? { toolCalls: projectToolCallArguments(turn.toolCalls, argumentsOf) } : {}),
      ...(turn.toolCallId ? { toolCallId: turn.toolCallId } : {}) })) }),
  serialize: output => JSON.stringify(output),
  references: turn => [...(turn.toolCalls?.map(call => call.id) ?? []), ...(turn.toolCallId ? [turn.toolCallId] : [])],
  assertReady: () => {},
};

const DEFAULT_SUMMARIZER = extractiveSummarizer;

export function extractiveSummarizer(
  turns: readonly ContextTurn[],
  maxTokens: number,
): { content: string; turnIds: readonly string[] } {
  if (turns.length === 0) return { content: "", turnIds: deepFreeze([]) as unknown as readonly string[] };
  const turnIds: string[] = [];
  const parts: string[] = [];
  let tokens = 0;
  for (const turn of turns) {
    const firstSentence = extractFirstSentence(turn.content);
    const sentenceTokens = estimateTokens(firstSentence);
    if (tokens + sentenceTokens > maxTokens) break;
    parts.push(`[T${turn.turnNumber}/${turn.role}] ${firstSentence}`);
    turnIds.push(turn.turnId);
    tokens += sentenceTokens;
  }
  if (parts.length === 0 && turns.length > 0) {
    const first = turns[0];
    if (first !== undefined) {
      const truncated = first.content.slice(0, maxTokens * 4);
      parts.push(`[T${first.turnNumber}/${first.role}] ${truncated}`);
      turnIds.push(first.turnId);
    }
  }
  return { content: parts.join("\n"), turnIds: deepFreeze([...turnIds]) as unknown as readonly string[] };
}

/**
 * Expand the keep set so a tool_calls group is kept or summarized
 * TOGETHER. If ANY member of a group is in the keep set, add every
 * member. This prevents orphaning an assistant tool_calls message from
 * its tool results (or vice versa) at the trim boundary.
 */
function expandKeepSetForToolCallGroups(turns: readonly ContextTurn[], keepSet: Set<string>, groups: readonly (readonly number[])[]): void {
  for (const group of groups) {
    let anyKept = false;
    for (const idx of group) {
      const t = turns[idx];
      if (t !== undefined && keepSet.has(t.turnId)) {
        anyKept = true;
        break;
      }
    }
    if (anyKept) {
      for (const idx of group) {
        const t = turns[idx];
        if (t !== undefined) keepSet.add(t.turnId);
      }
    }
  }
}

/**
 * Evict the oldest evictable GROUP from the front of `activeTurns` while
 * over the token limit. A tool_calls group (assistant + its tool
 * results) is evicted atomically — never split. Pinned turns are never
 * evicted. Returns the evicted turns (empty array if nothing evicted).
 * Does NOT record a summary: the prefix summarization (toSummarize)
 * already preserves the trimmed evidence; this over-limit eviction is a
 * safety net that drops the oldest group verbatim so the token count
 * stays under the hard limit (matching the original drop semantics).
 */
function evictOldestGroup(activeTurns: ContextTurn[], groups: readonly (readonly number[])[]): ContextTurn[] | null {
  if (activeTurns.length === 0) return null;
  // Any pinned member protects the entire chronological span.
  for (const group of groups) {
    const headIdx = group[0];
    if (headIdx === undefined) continue;
    const head = activeTurns[headIdx];
    if (head === undefined || group.some(index => activeTurns[index]!.pinned)) continue;
    // Evict this whole group from the array.
    const lastIdx = group[group.length - 1] ?? headIdx;
    const count = lastIdx - headIdx + 1;
    return activeTurns.splice(headIdx, count);
  }
  return null;
}

/**
 * A pure string → string transform applied to each turn's content BEFORE the
 * C09 conversation-summary topic is extracted. The backend memory layer is DECOUPLED
 * from the privacy layer: the redactor is INJECTED by the caller (the web UI
 * adapter passes `redactForLLMContext`; the backend runtime passes identity).
 * This mirrors the summarizer and delivery-projection injection points.
 * A domain-only caller may use the identity transform.
 */
export type ContextSummarizer = (turns: readonly ContextTurn[], maxTokens: number, evidence: readonly ContextTurn[]) =>
  { content: string; turnIds: readonly string[] };

export type TopicRedactor = (text: string) => string;
const IDENTITY_REDACTOR: TopicRedactor = (s) => s;

/**
 * How a tool call is turned into the bytes that leave.
 *
 * Both forms are injected together, by the layer that owns the transport, so
 * that the manager can hold them side by side and CHOOSE — see
 * `outboundToolCallArguments`. Injecting only one of them would put the
 * choice back where it was: in the emitter, out of the accounting's sight.
 *
 * The web adapter supplies redaction here; the backend runtime supplies the
 * verbatim default. Same seam as the summarizer and the topic redactor, so
 * this layer keeps no dependency on the transport above it.
 */
export type OutboundToolCallRenderer = Readonly<{
  /** The bytes a tool call contributes when the payload is sent whole. */
  whole(toolCall: ContextToolCall): string;
  /**
   * The bytes it contributes when abridged, with the proven way back.
   *
   * `deliveredFullText` is the WHOLE form of this same call — the bytes the
   * way back will hand over. It is passed rather than re-derived because the
   * notice states the size of what will arrive, and the only way to be sure
   * that size is right is to measure the string itself. Where the transport
   * masks credentials, the whole form is already the masked one, so the
   * notice's promise and the retrieval's answer are the same bytes by
   * construction instead of by two modules agreeing.
   */
  abridged(entry: ToolResultEntry, route: RetrievalRoute, deliveredFullText: string): string;
}>;

const VERBATIM_RENDERER: OutboundToolCallRenderer = Object.freeze({
  whole: (toolCall: ContextToolCall): string => toolCall.function.arguments,
  abridged: (entry: ToolResultEntry, route: RetrievalRoute, deliveredFullText: string): string =>
    abridgedReference(entry, route, deliveredFullText),
});

/**
 * THE SECOND PARAMETER USED TO BE A SOCKET WITH NOTHING PLUGGED INTO IT.
 *
 * It was `_memoryStore?: UnifiedMemoryStore` — declared, underscore-prefixed,
 * and referenced nowhere in the body. Meanwhile a measured tool-result store
 * sat three imports away, exported and configured, with zero consumers
 * anywhere in the product. A capability that exists and nothing calls is not
 * a half-finished feature; it is a cost being paid in full with none of the
 * benefit, and here the cost was measured: a real 55 KB artifact re-serialised
 * into every single request at ~14,000 tokens a turn, evicting the rest of the
 * conversation to stay inside the limit. The user experiences that as the
 * model forgetting everything immediately after making something, which reads
 * as a model defect and is a context-assembly defect.
 *
 * The socket now carries the store, and the manager USES it — for the token
 * accounting, which is the part that matters. Charging a turn the full weight
 * of a payload that is going to be sent abridged makes the manager evict
 * other turns to make room for tokens nobody will ever transmit.
 *
 * WHAT THIS DOES NOT DO, and it is binding: it does not change what is
 * RECORDED. `activeTurns` and `allTurnsById` keep every tool call's arguments
 * verbatim, and `state()` hands them back verbatim. A summary changes what is
 * SENT. The ledger is untouched.
 */
export function createUnifiedContextManager(
  config: UnifiedConfig,
  toolResultStore?: ToolResultStore,
  summarizer: ContextSummarizer = DEFAULT_SUMMARIZER,
  topicRedactor: TopicRedactor = IDENTITY_REDACTOR,
  renderOutbound: OutboundToolCallRenderer = VERBATIM_RENDERER,
  renderContent: TopicRedactor = IDENTITY_REDACTOR,
): UnifiedContextManager {
  const cfg = config;
  // Deny by default: with no proven way back, nothing is abridged, and the
  // charge below is the weight of the whole document — which is what would
  // actually be sent.
  let retrievalRoute: RetrievalRoute | null = null;
  let projectionIdentity: object = DOMAIN_PROJECTION;
  let serializeProjection = (input: ContextProjectionInput): string => DOMAIN_PROJECTION.serialize(DOMAIN_PROJECTION.project(input));
  let references = DOMAIN_PROJECTION.references;
  let assertReady = DOMAIN_PROJECTION.assertReady;

  function bindProjection<T>(projection: ContextProjection<T>): void {
    if (projectionIdentity === projection) return;
    if (allTurnsById.size || summaryList.length) throw new InputError("Context projection must be bound before capture", "context_projection_late");
    projectionIdentity = projection;
    serializeProjection = input => projection.serialize(projection.project(input));
    references = projection.references;
    assertReady = projection.assertReady;
  }

  function projectionInput(turns: readonly ContextTurn[] = activeTurns, includeSummary = true): ContextProjectionInput {
    return { turns, summaries: includeSummary ? [conversationSummary.buildBlock(), ...(summaryList.length
      ? ["Prior conversation (summarized):\n" + summaryList.map(summary => summary.content).join("\n")] : [])].filter(Boolean) : [],
      argumentsOf: outboundToolCallArguments, contentOf: renderContent };
  }

  function project<T>(projection: ContextProjection<T>): T {
    if (projectionIdentity !== projection) throw new InputError("Context projection is not bound", "context_projection_missing");
    assertReady([...allTurnsById.values()]);
    assertReady(activeTurns);
    return projection.project(projectionInput());
  }

  const groupsOf = (turns: readonly ContextTurn[]): readonly (readonly number[])[] => dependencySpans(turns.map(references));
  const activeTurns: ContextTurn[] = [];
  const summaryList: ContextSummary[] = [];
  const allTurnsById = new Map<string, ContextTurn>();
  const conversationSummary = new ConversationSummary({
    tokenBudget: cfg.summaryTokenBudget,
  });
  let trimCount = 0;
  // Monotonic turn counter — only increases, never reset across trims, so
  // auto-assigned turn numbers stay unique even after older turns evict.
  let nextTurnNumber = 1;

  function validateContent(input: AddTurnInput): void {
    if (input.responseItems !== undefined && projectionIdentity === DOMAIN_PROJECTION) {
      throw new InputError("Opaque context evidence requires a delivery projection", "context_projection_missing");
    }
    // Calls, empty results, opaque output and unresolved evidence all carry
    // meaning even when their display content is empty.
    if (input.content.length === 0 && !input.toolCalls?.length && input.responseItems === undefined && !input.responseReplayBlocked &&
        !(input.role === "tool" && input.toolCallId)) {
      throw new InputError("Context turn content is empty");
    }
  }

  function abridgementOf(tc: ContextToolCall): ToolResultEntry | null {
    if (toolResultStore === undefined) return null;
    return toolResultStore.add(tc.function.name, tc.function.arguments);
  }

  /**
   * THE ONE PLACE A TOOL CALL BECOMES OUTBOUND BYTES.
   *
   * The predecessor of this function answered a narrower question — "may this
   * payload be abridged?" — and left the emitter to answer the wider one on
   * its own, using a flag that never reached the accounting. Two places
   * decided one thing and only one of them knew the answer, so the manager
   * charged a summary's weight for a document it was about to send whole.
   * Making them agree by hand would have left the same two decisions in
   * place; this collapses them into one value that both readers read.
   *
   * It also refuses an abridgement that is not smaller than the document.
   * The abridged form has a floor — framing plus an opening — so a payload
   * just over the store's threshold came out BIGGER, and was announced to the
   * model as "only the opening is shown here" while carrying more tokens than
   * the whole text. Comparing the two forms we are already holding removes
   * that band for every tool and every future wording of the notice, which
   * re-deriving the threshold from today's floor would not.
   */
  function outboundToolCallArguments(tc: ContextToolCall): string {
    const whole = renderOutbound.whole(tc);
    if (retrievalRoute === null) return whole;
    const entry = abridgementOf(tc);
    if (entry === null) return whole;
    const abridged = renderOutbound.abridged(entry, retrievalRoute, whole);
    return estimateTokens(abridged) < estimateTokens(whole) ? abridged : whole;
  }

  function estimateTurn(turn: ContextTurn): number {
    return estimateTokens(serializeProjection(projectionInput([turn], false)));
  }

  function setRetrievalRoute(route: RetrievalRoute | null): void {
    const before = retrievalRoute?.toolName ?? null;
    const after = route?.toolName ?? null;
    if (before === after) return;
    retrievalRoute = route;
    // A turn's charge is the weight of what would be sent, and this is the
    // only thing that changes what would be sent. Re-deriving here is what
    // keeps "charged" and "sent" the same fact across a mid-run change to
    // the manifest — a breaker can switch the retrieval tool off between two
    // turns of one run, and the turns already recorded must not keep a price
    // from a request shape that no longer exists.
    for (let i = 0; i < activeTurns.length; i += 1) {
      const turn = activeTurns[i];
      if (turn === undefined || turn.toolCalls === undefined) continue;
      const repriced: ContextTurn = deepFreeze({
        ...turn,
        tokenEstimate: estimateTurn(turn),
      }) as ContextTurn;
      activeTurns[i] = repriced;
      allTurnsById.set(turn.turnId, repriced);
    }
  }

  function captureTurn(input: AddTurnInput): ContextTurn {
    validateContent(input);
    const turnNumber = input.turnNumber ?? nextTurnNumber;
    nextTurnNumber = Math.max(nextTurnNumber, turnNumber + 1);
    const turn: ContextTurn = {
      turnId: input.turnId ?? generateId("turn"),
      role: input.role,
      content: input.content,
      tokenEstimate: 0,
      timestamp: input.timestamp ?? new Date().toISOString(),
      pinned: input.pinned ?? false,
      sourceEventId: input.sourceEventId ?? null,
      turnNumber,
      ...(input.toolCalls !== undefined && input.toolCalls.length > 0 ? { toolCalls: input.toolCalls } : {}),
      ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
      ...(input.responseItems !== undefined ? { responseItems: input.responseItems } : {}),
      ...(input.responseReplayBlocked !== undefined ? { responseReplayBlocked: input.responseReplayBlocked } : {}),
    };
    return deepFreeze({ ...turn, tokenEstimate: estimateTurn(turn) });
  }

  function addTurn(input: AddTurnInput): ContextTurn {
    const turn = captureTurn(input);
    activeTurns.push(turn);
    allTurnsById.set(turn.turnId, turn);
    return turn;
  }

  function updateTurn(turnId: string, input: AddTurnInput): ContextTurn {
    const prior = allTurnsById.get(turnId);
    if (!prior) throw new InputError("Context turn does not exist", "context_turn_missing");
    const turn = captureTurn({ ...input, turnId, turnNumber: prior.turnNumber, timestamp: prior.timestamp,
      pinned: prior.pinned, ...(prior.sourceEventId === null ? {} : { sourceEventId: prior.sourceEventId }) });
    allTurnsById.set(turnId, turn);
    const index = activeTurns.findIndex(item => item.turnId === turnId);
    if (index >= 0) activeTurns[index] = turn;
    return turn;
  }

  function pinTurn(turnId: string): boolean {
    const idx = activeTurns.findIndex((t) => t.turnId === turnId);
    if (idx === -1) return false;
    const turn = activeTurns[idx];
    if (turn === undefined) return false;
    const pinned: ContextTurn = deepFreeze({ ...turn, pinned: true }) as ContextTurn;
    activeTurns[idx] = pinned;
    allTurnsById.set(turnId, pinned);
    return true;
  }

  function unpinTurn(turnId: string): boolean {
    const idx = activeTurns.findIndex((t) => t.turnId === turnId);
    if (idx === -1) return false;
    const turn = activeTurns[idx];
    if (turn === undefined) return false;
    const unpinned: ContextTurn = deepFreeze({ ...turn, pinned: false }) as ContextTurn;
    activeTurns[idx] = unpinned;
    allTurnsById.set(turnId, unpinned);
    return true;
  }

  const removeTurn = (turnId: string): boolean => contextRemoveTurn(turnId, activeTurns);

  const getTurn = (turnId: string): ContextTurn | null => contextGetTurn(turnId, allTurnsById);

  function turns(): readonly ContextTurn[] {
    return deepFreeze([...activeTurns]) as readonly ContextTurn[];
  }

  function summaries(): readonly ContextSummary[] {
    return deepFreeze([...summaryList]) as readonly ContextSummary[];
  }

  function recordSummaryTurn(turn: number, userMessage: string, assistantMessage: string): void {
    // redact PII from the turn content BEFORE extracting the topic
    // keyword so the stored summary topic never carries a raw secret (the
    // C09 block is also redacted at the LLM boundary by buildTrimmedHistory,
    // but redacting at the source is defense-in-depth — the derived topic is
    // the value that persists in the conversation summary). The redactor is
    // injected (see TopicRedactor) so this layer stays privacy-agnostic.
    const topic = ConversationSummary.extractTopic(topicRedactor(userMessage), topicRedactor(assistantMessage));
    conversationSummary.recordTurn(turn, topic);
  }

  function setMainTopic(topic: string): void {
    conversationSummary.setMainTopic(topic);
  }

  function tokenCount(): number {
    return estimateTokens(serializeProjection(projectionInput()));
  }

  function tokenLimit(): number {
    return cfg.contextTokenLimit;
  }

  function trimThreshold(): number {
    return cfg.trimThreshold;
  }

  function trimThresholdTokens(): number {
    return Math.floor(cfg.contextTokenLimit * cfg.trimThreshold);
  }

  const isOverThreshold = (): boolean => contextIsOverThreshold(tokenCount, trimThresholdTokens);

  const shouldTrim = (): boolean => contextShouldTrim(tokenCount, trimThresholdTokens);

  function trim(): ContextState {
    // A failed turn stays evidence even when outside the retained window. Only
    // an explicit recovery/clear can reopen replay; eviction is not recovery.
    assertReady([...allTurnsById.values()]);
    assertReady(activeTurns);
    if (!shouldTrim()) {
      return currentState(false);
    }
    trimCount += 1;
    const recentWindow = cfg.recentTurnWindow;
    const minRecentKept = cfg.minRecentTurnsKept;
    const pinnedTurns = activeTurns.filter((t) => t.pinned);
    const recentTurns = activeTurns.slice(-Math.max(recentWindow, minRecentKept));
    const keepSet = new Set<string>();
    for (const t of pinnedTurns) keepSet.add(t.turnId);
    for (const t of recentTurns) keepSet.add(t.turnId);
    // The delivery policy supplies dependency identities. Retain each entire
    // chronological span, including intervening records and overlapping spans.
    expandKeepSetForToolCallGroups(activeTurns, keepSet, groupsOf(activeTurns));
    const toSummarize = activeTurns.filter((t) => !keepSet.has(t.turnId));
    const toKeep = activeTurns.filter((t) => keepSet.has(t.turnId));
    let lastTrimmedTurnId: string | null = null;
    if (toSummarize.length > 0) {
      const { content, turnIds } = summarizer(toSummarize, cfg.summaryTokenBudget, [...allTurnsById.values()]);
      const summary: ContextSummary = deepFreeze({
        summaryId: generateId("sum"),
        turnIds: deepFreeze([...turnIds]) as unknown as readonly string[],
        content,
        tokenEstimate: estimateTokens(content),
        createdAt: new Date().toISOString(),
        sourceTurns: toSummarize.length,
      }) as ContextSummary;
      summaryList.push(summary);
      if (turnIds.length > 0) {
        lastTrimmedTurnId = turnIds[turnIds.length - 1] ?? null;
      }
    }
    activeTurns.length = 0;
    for (const turn of toKeep) activeTurns.push(turn);
    while (tokenCount() > cfg.contextTokenLimit && activeTurns.length > 0) {
      // Evict only whole dependency spans; any pinned member protects all of it.
      const evicted = evictOldestGroup(activeTurns, groupsOf(activeTurns));
      if (!evicted) break;
      if (lastTrimmedTurnId === null && evicted.length > 0) {
        lastTrimmedTurnId = evicted[evicted.length - 1]?.turnId ?? null;
      }
    }
    // BUG 1 FIX: prune accumulated summaries when their token weight alone
    // keeps the context over the limit. The eviction loop above only evicts
    // from activeTurns, never from summaryList — so after many trim cycles
    // the accumulated summaries (one per cycle) exceeded the context limit
    // with no recovery (the same class of bug as the 748% decorative-trim).
    // EXP435 contract: the conversation summary is rebuilt every turn, so
    // older progressive-trim summaries are the lowest-value, oldest-first
    // eviction candidate. Drop the oldest summary until the total is under
    // the limit (or no summaries remain — degenerate all-pinned case).
    while (tokenCount() > cfg.contextTokenLimit && summaryList.length > 0) {
      summaryList.shift();
    }
    return currentState(true, lastTrimmedTurnId);
  }

  function currentState(trimmed: boolean, lastTrimmedTurnId: string | null = null): ContextState {

  return deepFreeze({
      turns: deepFreeze([...activeTurns]) as readonly ContextTurn[],
      summaries: deepFreeze([...summaryList]) as readonly ContextSummary[],
      conversationSummaryBlock: conversationSummary.buildBlock(),
      totalTokens: tokenCount(),
      tokenLimit: cfg.contextTokenLimit,
      trimThreshold: cfg.trimThreshold,
      trimmed,
      lastTrimmedTurnId,
      trimCount,
    }) as ContextState;
  }

  function state(): ContextState {
    return currentState(false);
  }

  function clear(): void {
    activeTurns.length = 0;
    summaryList.length = 0;
    allTurnsById.clear();
    conversationSummary.clear();
    trimCount = 0;
  }

  const replaceTurns = (turns: readonly ContextTurn[]): void => { contextReplaceTurns(turns, activeTurns, allTurnsById); };

  // Note: we do NOT deepFreeze the returned object because
  // `conversationSummary` is a mutable builder (recordTurn, setMainTopic
  // mutate internal state). The internal arrays (activeTurns, summaryList)
  // are exposed via methods that return frozen copies, so callers cannot
  // mutate them directly.
  return {
    config: cfg,
    conversationSummary,
    toolResultStore: toolResultStore ?? null,
    outboundToolCallArguments,
    setRetrievalRoute,
    addTurn,
    updateTurn,
    bindProjection,
    project,
    pinTurn,
    unpinTurn,
    removeTurn,
    getTurn,
    turns,
    summaries,
    recordSummaryTurn,
    setMainTopic,
    tokenCount,
    tokenLimit,
    trimThreshold,
    trimThresholdTokens,
    isOverThreshold,
    shouldTrim,
    trim,
    state,
    clear,
    replaceTurns,
  } as UnifiedContextManager;
}
