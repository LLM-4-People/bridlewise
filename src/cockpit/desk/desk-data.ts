/**
 * DESK — pure data layer (§3.4 CONTEXT DESK · §3.5 BREAKER PANEL).
 *
 * Decoders for the two block reads (`run.compose`, `tools.breaker`) plus the
 * derivations the strips and rows render from. Everything here is a pure
 * function over SERVED wire data — no fetch, no store, no fabrication:
 *
 *   - a bar's fraction is tokens / total-of-served-channels, nothing else
 *     (`stripBarViolations` is the mechanical guard for exactly that);
 *   - the trim handle's numbering is the SAME numbering the block's `trim`
 *     action consumes (`beforeTurn` counts user turns of the full saved
 *     conversation), so the shown number IS the sent number
 *     (`trimNumbering` owns the offset math; mutation-tested);
 *   - the closed-desk edge summary exists only when ≠ all-on (§3.5).
 *
 * Malformed wire → `null` (the caller renders honest absence), never a
 * guessed shape.
 */

import { isRecord } from "../../state/coverage.ts";
// One owner for the confinement vocabulary: the decoder below validates
// against the same list the server reports from, so a state added on one side
// cannot quietly become an unrecognised value on the other.
import { CONFINEMENT_STATES, type ConfinementState } from "../../../shared/wire-types.ts";
// The composition channel vocabulary has ONE owner (shared/wire-types.ts) —
// the server's ComposeChannel type and Zod enums and this decoder all read
// it, so a channel added to the assembly reaches both sides of the wire.
import { COMPOSE_CHANNEL_IDS, type ComposeChannelId } from "../../../shared/wire-types.ts";

// ── run.compose wire → view ────────────────────────────────────────────────

export const CHANNEL_IDS = COMPOSE_CHANNEL_IDS;
export type ChannelId = ComposeChannelId;

export type StripItem = Readonly<{ id: string; label: string; tokens: number }>;

export type ComposeChannelView = Readonly<{
  id: ChannelId;
  tokens: number;
  items: readonly StripItem[];
}>;

export type ComposeSettingsView = Readonly<{
  pinnedMemoryIds: readonly string[];
  mutedChannels: readonly string[];
  mutedMemoryIds: readonly string[];
  trimBeforeTurn?: number;
}>;

export type ComposeView = Readonly<{
  channels: readonly ComposeChannelView[];
  /** The context manager's token limit for the next assembly — served. */
  limit: number;
  /** Sum of the served channels' tokens: the next turn's measured total. */
  total: number;
  settings: ComposeSettingsView;
}>;

/** A plain (non-array) object. Builds on the SINGLE `isRecord` owner
 * (src/state/coverage.ts) and adds the array exclusion these decoders need:
 * a channel or row that arrives as an array is malformed, not a record. */
function plainObject(v: unknown): v is Record<string, unknown> {
  return isRecord(v) && !Array.isArray(v);
}

/** A measured, finite number — or null. Never a coerced zero. */
function finiteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function stringArray(v: unknown): readonly string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function decodeItem(v: unknown): StripItem | null {
  if (!plainObject(v)) return null;
  const tokens = finiteNumber(v.tokens);
  if (typeof v.id !== "string" || typeof v.label !== "string" || tokens === null || tokens < 0) {
    return null;
  }
  return Object.freeze({ id: v.id, label: v.label, tokens });
}

/** Decode a `run.compose` read. Returns null on any malformed member — the
 * strip column then renders its honest absence, never a partial guess. */
export function decodeCompose(wire: unknown): ComposeView | null {
  if (!plainObject(wire) || !Array.isArray(wire.channels)) return null;
  const limit = finiteNumber(wire.limit);
  if (limit === null || limit <= 0) return null;
  const channels: ComposeChannelView[] = [];
  for (const raw of wire.channels) {
    if (!plainObject(raw)) return null;
    const id = raw.id;
    if (typeof id !== "string" || !(CHANNEL_IDS as readonly string[]).includes(id)) return null;
    const tokens = finiteNumber(raw.tokens);
    if (tokens === null || tokens < 0 || !Array.isArray(raw.items)) return null;
    const items: StripItem[] = [];
    for (const it of raw.items) {
      const decoded = decodeItem(it);
      if (decoded === null) return null;
      items.push(decoded);
    }
    channels.push(Object.freeze({ id: id as ChannelId, tokens, items: Object.freeze(items) }));
  }
  const settingsRaw = plainObject(wire.settings) ? wire.settings : {};
  const trimBeforeTurn = finiteNumber(settingsRaw.trimBeforeTurn);
  const settings: ComposeSettingsView = Object.freeze({
    pinnedMemoryIds: Object.freeze(stringArray(settingsRaw.pinnedMemoryIds)),
    mutedChannels: Object.freeze(stringArray(settingsRaw.mutedChannels)),
    mutedMemoryIds: Object.freeze(stringArray(settingsRaw.mutedMemoryIds)),
    ...(trimBeforeTurn !== null && trimBeforeTurn >= 1 ? { trimBeforeTurn } : {}),
  });
  const total = channels.reduce((sum, c) => sum + c.tokens, 0);
  return Object.freeze({ channels: Object.freeze(channels), limit, total, settings });
}

// ── run.composeItem wire → the REAL body behind one strip row ──────────────

/** Which wire field of the request this text is. An assistant turn sends its
 * prose and its tool calls as two different message fields, and the tool
 * schemas are not a message field at all — they ride the request's own
 * `tools` array; naming which is which is the difference between showing
 * the request and paraphrasing it. */
export const ITEM_FIELDS = ["content", "tool_calls", "schema"] as const;
export type ItemField = (typeof ITEM_FIELDS)[number];

export type ItemPartView = Readonly<{ role: string; field: ItemField; text: string }>;

export type ItemDetailView = Readonly<{
  channel: ChannelId;
  itemId: string;
  label: string;
  tokens: number;
  /** Plain words: where this text comes from and when (served). */
  origin: string;
  /** The composed body in send order. Empty = see `absence`. */
  parts: readonly ItemPartView[];
  /** Characters the server withheld at its payload ceiling. */
  withheldChars: number;
  /** Served reason there is no body, when there genuinely is none. */
  absence: string | null;
}>;

function decodePart(v: unknown): ItemPartView | null {
  if (!plainObject(v)) return null;
  if (typeof v.role !== "string" || typeof v.text !== "string") return null;
  if (typeof v.field !== "string" || !(ITEM_FIELDS as readonly string[]).includes(v.field)) {
    return null;
  }
  return Object.freeze({ role: v.role, field: v.field as ItemField, text: v.text });
}

/** Decode a `run.composeItem` read. Null on any malformed member — the scope
 * then says the body was not readable, never renders a placeholder body. */
export function decodeItemDetail(wire: unknown): ItemDetailView | null {
  if (!plainObject(wire) || !Array.isArray(wire.parts)) return null;
  const tokens = finiteNumber(wire.tokens);
  const withheldChars = finiteNumber(wire.withheldChars);
  if (
    typeof wire.channel !== "string" ||
    !(CHANNEL_IDS as readonly string[]).includes(wire.channel) ||
    typeof wire.itemId !== "string" ||
    typeof wire.label !== "string" ||
    typeof wire.origin !== "string" ||
    tokens === null ||
    tokens < 0 ||
    withheldChars === null ||
    withheldChars < 0
  ) {
    return null;
  }
  const parts: ItemPartView[] = [];
  for (const raw of wire.parts) {
    const decoded = decodePart(raw);
    if (decoded === null) return null;
    parts.push(decoded);
  }
  return Object.freeze({
    channel: wire.channel as ChannelId,
    itemId: wire.itemId,
    label: wire.label,
    tokens,
    origin: wire.origin,
    parts: Object.freeze(parts),
    withheldChars,
    absence: typeof wire.absence === "string" && wire.absence.length > 0 ? wire.absence : null,
  });
}

/** One call inside a `tool_calls` part, as the wire carries it. */
export type ToolCallView = Readonly<{ name: string; args: unknown }>;

/** A call's `arguments` decoded, or the exact string when it is not JSON —
 * an unparseable argument list is still what the model was handed, so it is
 * kept rather than dropped. */
function parseArgsOrKeep(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    void err; // the string is the answer; nothing is lost and nothing failed
    return raw;
  }
}

/**
 * Decode a `tool_calls` part's text into the calls it really contains, so
 * the scope can render each one through the render layer's own tool-input
 * renderer — the SAME one the flow uses, so a call looks like itself
 * wherever it is read.
 *
 * Null when the text is not the array it claims to be: the caller then
 * shows the raw text rather than a shape this never verified. `arguments`
 * is a JSON string on the wire; when it does not parse it is handed on as
 * the string it is, never dropped.
 */
export function decodeToolCalls(text: string): readonly ToolCallView[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const calls: ToolCallView[] = [];
  for (const raw of parsed) {
    if (!plainObject(raw)) return null;
    const fn = plainObject(raw.function) ? raw.function : null;
    if (fn === null || typeof fn.name !== "string") return null;
    // `arguments` is a JSON string on the wire. When it does not parse, the
    // string itself IS what the model was handed, so it is kept verbatim —
    // the failure is the answer here, not something to report or swallow.
    const wireArgs: unknown = fn.arguments;
    const args = typeof wireArgs === "string" ? parseArgsOrKeep(wireArgs) : wireArgs;
    calls.push(Object.freeze({ name: fn.name, args }));
  }
  return Object.freeze(calls);
}

/**
 * MECHANICAL GUARD (mutation-tested): a detail view may only render text the
 * SERVER sent. Any part whose text is not a substring of the served body —
 * a placeholder, a summary, an "(empty)" stand-in — is a violation, and so
 * is a body claiming to be whole while the server withheld characters
 * without the view carrying the count.
 */
export function itemBodyViolations(
  view: ItemDetailView,
  served: ItemDetailView,
): string[] {
  const out: string[] = [];
  if (view.parts.length !== served.parts.length) {
    out.push(`body shows ${view.parts.length} parts, the server sent ${served.parts.length}`);
  }
  for (const [i, part] of view.parts.entries()) {
    const from = served.parts[i];
    if (from === undefined) {
      out.push(`part ${i} has no served counterpart — fabricated body`);
      continue;
    }
    if (!from.text.includes(part.text)) {
      out.push(`part ${i} shows text the server never sent — fabricated body`);
    }
    if (part.field !== from.field || part.role !== from.role) {
      out.push(`part ${i} is labelled ${part.role}/${part.field}, served as ${from.role}/${from.field}`);
    }
  }
  if (view.withheldChars !== served.withheldChars) {
    out.push(`withheld count ${view.withheldChars} ≠ served ${served.withheldChars}`);
  }
  return out;
}

// ── Strips: measured bars only ─────────────────────────────────────────────

export type StripView = Readonly<{
  channel: ComposeChannelView;
  /** Engraved strip name in plain words (with its measured count). */
  name: string;
  /** MEASURED share of the next composition: tokens / total. 0 when the
   * composition is empty. This is the ONLY source a bar may render from. */
  fraction: number;
}>;

const CHANNEL_NAMES: Readonly<Record<ChannelId, (c: ComposeChannelView) => string>> = {
  system: () => "System prompt",
  memories: (c) => c.items.length === 0 ? "Memories" : `Memories (${c.items.length})`,
  history: (c) => {
    const turns = c.items.filter((i) => /^turn-[1-9]\d*$/.test(i.id)).length;
    return `History · ${turns} turn${turns === 1 ? "" : "s"} sent`;
  },
  toolResults: (c) => c.items.length === 0 ? "Tool results" : `Tool results (${c.items.length})`,
  // The schemas' own tool count lives in the served item's label (the
  // channel is one measured body, not a list of tools) — derived there,
  // never restated here.
  toolSchemas: () => "Tool schemas",
};

/** Derive the strip views from a served composition. Order is the served
 * order (the assembly's own order); nothing is added or invented — a channel
 * the server does not emit (e.g. `files` in this assembly) does not exist. */
export function stripsFrom(view: ComposeView): readonly StripView[] {
  return view.channels.map((channel) =>
    Object.freeze({
      channel,
      name: CHANNEL_NAMES[channel.id](channel),
      fraction: view.total > 0 ? channel.tokens / view.total : 0,
    }),
  );
}

/**
 * MECHANICAL GUARD (mutation-tested): every bar fraction must be exactly the
 * served tokens over the served total — a fraction from anywhere else (an
 * equal-width fallback, a stale total, a simulated share) is a violation.
 */
export function stripBarViolations(
  strips: readonly StripView[],
  view: ComposeView,
): string[] {
  const out: string[] = [];
  if (strips.length !== view.channels.length) {
    out.push(`strip count ${strips.length} ≠ served channel count ${view.channels.length}`);
  }
  for (const strip of strips) {
    const served = view.channels.find((c) => c.id === strip.channel.id);
    if (served === undefined) {
      out.push(`strip "${strip.channel.id}" has no served channel — fabricated strip`);
      continue;
    }
    const expected = view.total > 0 ? served.tokens / view.total : 0;
    if (strip.fraction !== expected) {
      out.push(
        `strip "${strip.channel.id}" bar ${strip.fraction} ≠ served ${served.tokens}/${view.total}`,
      );
    }
  }
  return out;
}

// ── Trim numbering (the block's own numbering, §3.4) ───────────────────────

/**
 * The HISTORY strip's trim numbering. The block's `trim { beforeTurn }`
 * counts user turns of the FULL saved conversation (1-based), but the read
 * only serves the post-trim window, whose `turn-N` items restart at 1. This
 * owner maps between the two so the number the handle SHOWS is the number
 * the action SENDS:
 *
 *   full turn of displayed turn k  =  k + offset,
 *   offset = recorded trimBeforeTurn − 1 (0 when no trim is recorded).
 *
 * Known edge, stated: a recorded beforeTurn past the end is clamped by the
 * assembly to the last turn; the desk's own slider never creates such a
 * state (max = the last displayed turn's full number).
 */
export type TrimNumbering = Readonly<{
  /** Full-conversation turn number of displayed turn k = k + offset. */
  offset: number;
  /** The first SENT turn in full numbering — the current trim point. */
  current: number;
  /** Smallest full turn number the slider can address — turn 1, always:
   * the slider can WIDEN the window as well as tighten it (the action
   * accepts any turn; a trim that could only ever tighten would be a
   * one-way verb, §3.4). */
  min: number;
  /** Largest useful beforeTurn: keep only the last displayed turn. */
  max: number;
  /** Displayed (post-trim) user-turn count. */
  displayedTurns: number;
}>;

export function trimNumbering(view: ComposeView): TrimNumbering | null {
  const history = view.channels.find((c) => c.id === "history");
  if (history === undefined) return null;
  const displayedTurns = history.items.filter((i) => /^turn-[1-9]\d*$/.test(i.id)).length;
  if (displayedTurns === 0) return null;
  const offset = Math.max(0, (view.settings.trimBeforeTurn ?? 1) - 1);
  return Object.freeze({
    offset,
    current: offset + 1,
    min: 1,
    max: offset + displayedTurns,
    displayedTurns,
  });
}

/** Full-conversation turn number of a displayed `turn-N` item id (null for
 * the context frame / non-turn items). */
export function fullTurnOfItem(itemId: string, numbering: TrimNumbering): number | null {
  const m = /^turn-([1-9]\d*)$/.exec(itemId);
  if (m === null) return null;
  return Number(m[1]) + numbering.offset;
}

/**
 * Re-spell a history item's label in the FULL saved conversation's turn
 * numbering — the numbering the `trim` action consumes — so the numbers on
 * the strip and the number the handle sends are ONE vocabulary. The served
 * label's `turn N:` prefix counts inside the post-trim window; this swaps in
 * `N + offset` (a deterministic relabel from served data, not a new count).
 * Non-turn items (the context frame) pass through unchanged.
 */
export function relabelHistoryItem(item: StripItem, numbering: TrimNumbering): StripItem {
  const full = fullTurnOfItem(item.id, numbering);
  if (full === null) return item;
  return Object.freeze({
    ...item,
    label: item.label.replace(/^turn [1-9]\d*:/, `turn ${full}:`),
  });
}

// ── tools.breaker wire → rows ──────────────────────────────────────────────

export const BREAKER_STATES = ["on", "off", "tripped"] as const;
export type BreakerState = (typeof BREAKER_STATES)[number];

export type BreakerRowView = Readonly<{
  id: string;
  label: string;
  description?: string;
  state: BreakerState;
  calls: number;
  lastMs?: number;
  lastError?: string;
  tripAfterFailures?: number;
}>;

/** Decode a `tools.breaker` read. Null on malformed wire → honest absence. */
export function decodeBreakerRows(wire: unknown): readonly BreakerRowView[] | null {
  if (!Array.isArray(wire)) return null;
  const rows: BreakerRowView[] = [];
  for (const raw of wire) {
    if (!plainObject(raw)) return null;
    const calls = finiteNumber(raw.calls);
    if (
      typeof raw.id !== "string" ||
      typeof raw.label !== "string" ||
      typeof raw.state !== "string" ||
      !(BREAKER_STATES as readonly string[]).includes(raw.state) ||
      calls === null ||
      calls < 0
    ) {
      return null;
    }
    const lastMs = finiteNumber(raw.lastMs);
    const tripAfter = finiteNumber(raw.tripAfterFailures);
    rows.push(
      Object.freeze({
        id: raw.id,
        label: raw.label,
        ...(typeof raw.description === "string" && raw.description.trim().length > 0
          ? { description: raw.description }
          : {}),
        state: raw.state as BreakerState,
        calls,
        ...(lastMs !== null && lastMs >= 0 ? { lastMs } : {}),
        ...(typeof raw.lastError === "string" && raw.lastError.length > 0
          ? { lastError: raw.lastError }
          : {}),
        ...(tripAfter !== null && tripAfter >= 1 ? { tripAfterFailures: tripAfter } : {}),
      }),
    );
  }
  return Object.freeze(rows);
}

/**
 * Closed-desk edge summary (§3.5): `tools 31/34` ONLY when ≠ all-on — the
 * edge is dark when normal. Null = nothing renders.
 */
export function toolsEdgeSummary(rows: readonly BreakerRowView[]): string | null {
  if (rows.length === 0) return null;
  let on = 0;
  for (const row of rows) if (row.state === "on") on++;
  return on === rows.length ? null : `tools ${on}/${rows.length}`;
}

// ── The executing tool (shared run-stream truth, §3.5) ─────────────────────

/** Minimal shape of a chat message this derivation needs (structural, so
 * the helper stays node-testable without importing the store module). */
export type ToolCallLike = Readonly<{
  role: string;
  toolCall?: Readonly<{ name: string; status: string }>;
}>;

/**
 * The tool with a call GENUINELY in flight, from the flow's own store data
 * (the one run stream — no second stream, no timer): the latest tool
 * message whose recorded status is still "running", and only while the run
 * itself is streaming (a dropped stream must not leave a phantom glow).
 */
export function executingToolName(
  messages: readonly ToolCallLike[],
  streaming: boolean,
): string | null {
  if (!streaming) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role === "tool" && m.toolCall !== undefined && m.toolCall.status === "running") {
      return m.toolCall.name;
    }
  }
  return null;
}

// ── Formatting (measured numbers, plain words) ─────────────────────────────

export function fmtTokens(n: number): string {
  return n.toLocaleString("en-US");
}

/** Duration in the row's own register: sub-second → ms, else one decimal s. */
export function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Share of the composition as an integer percent (display only — bars use
 * the raw fraction). */
export function fmtPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

// ── tools.confinement wire → view ──────────────────────────────────────────

/**
 * HOW MUCH OF THIS COMPUTER A RUN'S COMMANDS CAN REACH.
 *
 * Four states, and the fourth is the point. "Not confined" and "cannot tell"
 * are different facts about the world and they call for different actions —
 * one is a setting to change, the other is something broken to look at — so a
 * reading that collapsed them would be answering a question it had not asked.
 * The server measures all four; this only decodes them.
 */
export { CONFINEMENT_STATES };
export type { ConfinementState };

export type ConfinementView = Readonly<{
  state: ConfinementState;
  /** The server's own plain sentence — not re-worded here. */
  sentence: string;
  /** Why, naming the inputs that decided it. */
  reason: string;
  measuredAt: number;
  kernelAbi: number | null;
  guardianSha256: string | null;
  code: string | null;
}>;

/**
 * Decode the confinement reading. A malformed answer becomes `null`, which
 * the surface renders as absence.
 *
 * NOTHING IS DEFAULTED HERE. A missing `state` does not become "off" and an
 * unrecognised one does not fall back to a safe-looking value: either would
 * turn a broken answer into a confident claim about this machine's
 * filesystem authority, which is the one claim that must never be guessed.
 */
export function decodeConfinement(wire: unknown): ConfinementView | null {
  if (!plainObject(wire)) return null;
  const { state, sentence, reason, measuredAt } = wire;
  if (
    typeof state !== "string" ||
    !(CONFINEMENT_STATES as readonly string[]).includes(state) ||
    typeof sentence !== "string" ||
    sentence.length === 0 ||
    typeof reason !== "string" ||
    reason.length === 0
  ) {
    return null;
  }
  const at = finiteNumber(measuredAt);
  if (at === null) return null;
  return Object.freeze({
    state: state as ConfinementState,
    sentence,
    reason,
    measuredAt: at,
    kernelAbi: finiteNumber(wire.kernelAbi),
    guardianSha256: typeof wire.guardianSha256 === "string" ? wire.guardianSha256 : null,
    code: typeof wire.code === "string" ? wire.code : null,
  });
}

/**
 * The short words for the closed desk, beside the context reading.
 *
 * "in this project" and "this whole computer" rather than any word from the
 * sandbox's own vocabulary: a reader who has never heard of Landlock has to
 * be able to tell, from these three words, how much is at stake when the
 * model runs something.
 */
export function confinementEdge(view: ConfinementView): string {
  switch (view.state) {
    case "confined":
      return "Command access: this project";
    case "off":
      return "Command access: whole computer";
    case "unavailable":
      return "Command access: blocked";
    case "unknown":
      return "Command access: unknown";
  }
}
