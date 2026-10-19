/**
 * Tool-result store (from EXP433, 95.1% token savings).
 *
 * Stores tool results in memory (with deterministic summaries in
 * context + on-demand semantic retrieval). The LLM gets a ~100-token
 * summary in context instead of the ~1000-token full result, and can
 * `retrieve(id)` the full result (or chunks of it) when needed.
 *
 * The store pays off for LARGE results; for small results a
 * `skipIfSmallTokens` threshold returns the full result directly
 * (no overhead). Realistic retrieval rate ~10% → 95.1% token savings.
 *
 * Per-tool deterministic summary generator (no LLM in the summary loop):
 * - search_code: top-K results (name, path, line).
 * - read_file: first/last 3 lines + count.
 * - grep: top-K matches (file:line).
 * - generic: first 200 chars.
 */
import { deepFreeze, sha256 } from "../../kernel/integrity.ts";
import { estimateTokens } from "./tokenizer.ts";
import { InputError } from "../../kernel/errors.ts";
import { DEFAULT_MEMORY_PREVIEW_CHARS } from "../memory-config.ts";

/**
 * How many hex characters of the content digest an entry id carries. Fixed
 * width is the property that matters (see `idFor`): every reference to an
 * entry costs the same tokens whichever entry it is, so a turn's memoised
 * charge cannot drift from the bytes it will send. 64 bits, and a collision
 * is refused rather than resolved.
 */
const ID_HEX_CHARS = 16;

export type ToolResultConfig = Readonly<{
  skipIfSmallTokens: number;
  lruCapacity: number;
  chunkLines: number;
  chunkStride: number;
  maxChunkChars: number;
}>;

/**
 * `skipIfSmallTokens` DECIDES WHAT IS WORTH STORING, NOT WHAT IS SENT.
 *
 * It used to decide both, and the two questions have different answers. The
 * abridged form has a floor — framing plus an opening of up to
 * `DEFAULT_MEMORY_PREVIEW_CHARS` — so for a band of payloads just over the
 * threshold the "abridgement" is LARGER than the document it replaces. A
 * payload of 400 characters cost 104 tokens whole and 144 abridged: a 38%
 * increase, sold to the model as "only the opening is shown here".
 *
 * Re-deriving this number from the floor would fix today's band and leave the
 * next one open, because the floor moves whenever the framing or the summary
 * generator changes and nothing would force the constant to move with it. So
 * the threshold no longer decides: the single place that renders a tool call's
 * outbound bytes compares the two forms it is holding and sends the smaller
 * one. An abridgement that costs more than the document is unrepresentable —
 * for any tool, any framing and any value of this number.
 *
 * What is left here is storage hygiene: below this size an entry is not worth
 * an LRU slot, an id or a saving to count.
 */
export const DEFAULT_TOOL_RESULT_CONFIG: ToolResultConfig = deepFreeze({
  skipIfSmallTokens: 100,
  lruCapacity: 256,
  chunkLines: 50,
  chunkStride: 40,
  maxChunkChars: 1000,
});

export type ToolResultEntry = Readonly<{
  id: string;
  toolName: string;
  summary: string;
  fullResult: string;
  chunks: readonly string[];
  tokensSaved: number;
  retrievedCount: number;
  storedAt: number;
}>;

export type ToolResultStats = Readonly<{
  totalEntries: number;
  totalTokensSaved: number;
  retrievals: number;
  retrievalMisses: number;
  skippedSmall: number;
  lruEvictions: number;
}>;

export interface ToolResultStore {
  readonly config: ToolResultConfig;
  /** Add a tool result. If small (< skipIfSmallTokens), returns null (caller returns full). */
  add(toolName: string, fullResult: string): ToolResultEntry | null;
  /** Get the full result by id. */
  getFullResult(id: string): string | null;
  /** Get the summary (what goes in context). */
  getSummary(id: string): string | null;
  /** Get the entry metadata. */
  getEntry(id: string): ToolResultEntry | null;
  /** Retrieve chunks matching a query (semantic: cosine over chunk embeddings, or TF-IDF fallback). */
  retrieve(query: string, topK: number): readonly { entryId: string; chunk: string; score: number }[];
  /** Stats. */
  stats(): ToolResultStats;
  // There is no `configure`. There was one, and it could never have worked:
  // the config object it assigned into is the same object handed out as
  // `config`, which is deep-frozen — so every call threw `Cannot assign to
  // read only property`, for every caller, on every path. It had none. Runtime
  // reconfiguration of this store would also have to re-derive the LRU
  // capacity from the context limit it is coupled to (see
  // `minimumLruCapacityForContext`), which a partial assign cannot do, so the
  // resolver stays the single owner of these values.
  /** Reset. */
  clear(): void;
}

export function createToolResultStore(config: Partial<ToolResultConfig> = {}): ToolResultStore {
  const cfg: ToolResultConfig = { ...DEFAULT_TOOL_RESULT_CONFIG, ...config } as ToolResultConfig;
  if (cfg.skipIfSmallTokens < 0 || !Number.isFinite(cfg.skipIfSmallTokens)) {
    throw new InputError("toolResult.skipIfSmallTokens must be >= 0");
  }
  if (cfg.lruCapacity < 1 || !Number.isFinite(cfg.lruCapacity)) {
    throw new InputError("toolResult.lruCapacity must be >= 1");
  }
  const entries = new Map<string, ToolResultEntry>();
  const lru: string[] = [];
  let retrievals = 0;
  let retrievalMisses = 0;
  let skippedSmall = 0;
  let lruEvictions = 0;
  let totalTokensSaved = 0;

  /**
   * THE ID IS A FUNCTION OF THE CONTENT, AND THAT IS WHAT MAKES THE CHARGE
   * STABLE.
   *
   * It used to be a counter (`tr-1`, `tr-2`, … in base 36) beside a
   * content→id index that existed solely to make storing idempotent. Two
   * mechanisms answering one question, and the counter form had a property
   * nobody had written down: **its width grows**. A context turn memoises its
   * token weight when it is recorded, and the weight of an abridged reference
   * includes the id — twice. So an entry that aged out under LRU pressure and
   * was minted again came back under a WIDER id, and the turn's memoised
   * charge silently stopped describing the bytes that leave. Driven over 600
   * turns of production ordering the gap reached 8 tokens: small, real, and
   * unbounded in principle, because nothing tied the two together.
   *
   * A digest of the bytes removes the cause rather than bounding it. Identical
   * content is identical id — for the whole life of the process, across
   * eviction and re-minting — so re-minting cannot move a charge, idempotence
   * is structural instead of indexed, and the id a model was handed several
   * turns ago still names the same document if the store still holds it.
   *
   * 16 hex characters (64 bits) is a fixed width, so every reference to an
   * entry costs the same tokens whichever entry it is. A collision would be
   * the one answer this store may never give — the wrong document under a
   * right-looking id — so it is REFUSED rather than resolved: at 64 bits and
   * the entry counts a conversation can reach, seeing one at all is stronger
   * evidence of a bug than of chance.
   */
  function idFor(fullResult: string): string {
    return `tr-${sha256(fullResult).slice(0, ID_HEX_CHARS)}`;
  }

  function lruTouch(id: string): void {
    const i = lru.indexOf(id);
    if (i >= 0) lru.splice(i, 1);
    lru.push(id);
    while (lru.length > cfg.lruCapacity) {
      const evicted = lru.shift();
      if (evicted !== undefined) {
        entries.delete(evicted);
        lruEvictions += 1;
      }
    }
  }

  return {
    config: deepFreeze(cfg) as ToolResultConfig,
    add(toolName: string, fullResult: string): ToolResultEntry | null {
      const tokens = estimateTokens(fullResult);
      if (tokens < cfg.skipIfSmallTokens) {
        skippedSmall += 1;
        return null;
      }
      const id = idFor(fullResult);
      const existing = entries.get(id);
      if (existing !== undefined) {
        if (existing.fullResult !== fullResult) {
          throw new InputError(
            `tool-result id ${id} already holds different bytes — refusing to serve the wrong document under a right-looking id`,
          );
        }
        lruTouch(id);
        return existing;
      }
      const summary = generateSummary(toolName, fullResult);
      const chunks = chunkToolResult(toolName, fullResult, cfg);
      const summaryTokens = estimateTokens(summary);
      const entry: ToolResultEntry = deepFreeze({
        id,
        toolName,
        summary,
        fullResult,
        chunks,
        tokensSaved: tokens - summaryTokens,
        retrievedCount: 0,
        storedAt: Date.now(),
      }) as ToolResultEntry;
      entries.set(id, entry);
      lruTouch(id);
      totalTokensSaved += entry.tokensSaved;
      return entry;
    },
    getFullResult(id: string): string | null {
      const e = entries.get(id);
      if (e === undefined) {
        retrievalMisses += 1;
        return null;
      }
      retrievals += 1;
      lruTouch(id);
      return e.fullResult;
    },
    getSummary(id: string): string | null {
      const e = entries.get(id);
      if (e === undefined) return null;
      return e.summary;
    },
    getEntry(id: string): ToolResultEntry | null {
      return entries.get(id) ?? null;
    },
    retrieve(query: string, topK: number): readonly { entryId: string; chunk: string; score: number }[] {
      retrievals += 1;
      const qTokens = query.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 1);
      if (qTokens.length === 0) return [];
      const results: { entryId: string; chunk: string; score: number }[] = [];
      for (const e of entries.values()) {
        for (const chunk of e.chunks) {
          const score = lexicalScore(chunk, qTokens);
          if (score > 0) {
            results.push({ entryId: e.id, chunk, score });
          }
        }
      }
      results.sort((a, b) => b.score - a.score);
      const top = results.slice(0, topK);
      // Mark retrieved.
      for (const r of top) {
        const e = entries.get(r.entryId);
        if (e !== undefined) {
          (entries as Map<string, ToolResultEntry>).set(r.entryId, deepFreeze({
            ...e,
            retrievedCount: e.retrievedCount + 1,
          }) as ToolResultEntry);
        }
      }
      if (top.length === 0) retrievalMisses += 1;
      return top;
    },
    stats() {
      return deepFreeze({
        totalEntries: entries.size,
        totalTokensSaved,
        retrievals,
        retrievalMisses,
        skippedSmall,
        lruEvictions,
      }) as ToolResultStats;
    },
    clear() {
      entries.clear();
      lru.length = 0;
      retrievals = 0;
      retrievalMisses = 0;
      skippedSmall = 0;
      lruEvictions = 0;
      totalTokensSaved = 0;
    },
  };
}

function lexicalScore(text: string, queryTokens: readonly string[]): number {
  const lower = text.toLowerCase();
  let hit = 0;
  for (const t of queryTokens) {
    if (lower.includes(t)) hit += 1;
  }
  return hit / Math.max(1, queryTokens.length);
}

declare const RETRIEVAL_ROUTE_BRAND: unique symbol;

/**
 * A PROVEN way back to the full text — the name of a retrieval tool that was
 * READ OUT OF the manifest the run is actually sending.
 *
 * The way back used to be a sentence, and the only thing standing between a
 * true sentence and a false one was `howToGetTheRest.trim().length === 0`.
 * That establishes non-emptiness, which is not the property that matters.
 * Driven, it accepted a zero-width space, a NUL byte, `"."`, and — the one
 * that would have shipped — `'…call get_tool_result with id "tr-1".'`: a
 * fluent, plausible sentence naming a tool the model does not have. The
 * abridgement would have been correct in every visible respect and the route
 * out of it a dead end, which is the exact defect the notice exists to
 * prevent, wearing the notice's own clothes.
 *
 * So the sentence is no longer supplied. This type is the evidence, it is
 * BRANDED so no string can stand in for it, and `retrievalRouteFor` is the
 * only door: it takes the tool names being sent and the name to look for, and
 * returns `null` when the manifest does not carry it. A caller with no route
 * has nothing to pass, and `abridgedReference` cannot be called — so an
 * abridgement whose way back was never checked against the manifest does not
 * compile, rather than being caught by an assertion someone had to write.
 */
export type RetrievalRoute = Readonly<{
  toolName: string;
  readonly [RETRIEVAL_ROUTE_BRAND]: true;
}>;

/**
 * The route to the full text, or `null` when this run is not sending the
 * retrieval tool.
 *
 * `toolNames` must be the names the run is ACTUALLY sending to the model —
 * the same list the provider receives, never a declared or default one. The
 * two facts "the model was told to call X" and "the model was given X" come
 * from this one argument.
 */
export function retrievalRouteFor(
  toolNames: readonly string[],
  retrieveToolName: string,
): RetrievalRoute | null {
  for (const name of toolNames) {
    if (name === retrieveToolName) {
      return deepFreeze({ toolName: retrieveToolName }) as unknown as RetrievalRoute;
    }
  }
  return null;
}

/**
 * THE SUMMARY IS A TRUNCATION, AND A TRUNCATION THAT DOES NOT SAY SO IS A LIE
 * WITH A PLAUSIBLE SHAPE.
 *
 * `generateSummary`'s generic branch is a literal prefix of the original — it
 * invents nothing, which is the important half. But driven over a real
 * 55 KB artifact it produces this:
 *
 *     [create_artifact] {"title":"Tetris","kind":"html","content":"<!doctype
 *     html>\n<html>\n<head>\n<style>\n.gravity-rect { color: #022166; padd
 *
 * — a JSON fragment that begins exactly like the whole document and simply
 * stops. Nothing in it says it was cut, how much is missing, or how to get
 * the rest. A reader given that has been told something false about the
 * shape of what it holds, without a single fabricated character. That is the
 * same family as a refusal rendered as an empty list: the omission is
 * invisible precisely where it matters.
 *
 * So the reference states, in plain words: that this is an abridgement, how
 * large the original is, the id that names it, and THE WAY BACK. The way back
 * is WRITTEN HERE from the `RetrievalRoute` the caller proved — the layer
 * still does not choose what the surrounding system calls its retrieval, but
 * it no longer accepts a sentence about it either, because a sentence can be
 * fluent and wrong and this function had no way to tell.
 *
 * A caller that cannot produce a route cannot call this: an abridgement with
 * no route to the full text is a deletion that reports success.
 *
 * ── AND IT DESCRIBES WHAT WILL ARRIVE, NOT WHAT IS FILED ─────────────────
 *
 * Both halves of this notice used to be false the moment redaction fired. It
 * announced the size of the STORED copy — "the full text is 52,209 bytes" —
 * and then promised "nothing has been changed or removed", while the way back
 * it names masks credentials on the way out and returns 18,319 bytes. A model
 * that asked for the full text got a smaller, altered document than the one
 * it had been promised, with nothing saying so: a truncation that does not
 * say so, in the notice written to stop truncations that do not say so.
 *
 * The record is not the problem and must not be "fixed": masking changes what
 * is SENT and never what was RECORDED, so the stored copy is genuinely
 * intact. The notice was describing the wrong one of the two.
 *
 * So `deliveredFullText` is the EXACT string the way back will return, and
 * both facts are read off it rather than asserted: the byte count is measured
 * from it, and whether anything was masked is decided by comparing it with
 * the stored copy. The caller cannot state a size that disagrees with what
 * arrives, because it does not state a size at all — and the sentence about
 * change is true when nothing was masked AND when something was.
 */
export function abridgedReference(
  entry: ToolResultEntry,
  route: RetrievalRoute,
  deliveredFullText: string,
): string {
  const bytes = Buffer.byteLength(deliveredFullText, "utf8");
  const masked = deliveredFullText !== entry.fullResult;
  return [
    `[abridged: only the opening of this ${entry.toolName} payload is shown here]`,
    `Calling for the full text under id ${entry.id} returns ${bytes} bytes. `
      + (masked
        ? "Values that look like credentials are masked as [REDACTED:…] on the way to you; the stored copy is unchanged, and nothing else has been altered or removed."
        : "Nothing in it has been changed or removed."),
    `To read the full text, call ${route.toolName} with id "${entry.id}". Do not reconstruct it from the opening shown below — call the tool.`,
    "",
    "Opening of the original:",
    entry.summary,
  ].join("\n");
}

/**
 * THE SMALLEST NUMBER OF ENTRIES THIS STORE MUST HOLD FOR A CONTEXT OF
 * `contextTokenLimit` TOKENS — the coupling nothing used to state.
 *
 * The store evicts by LRU count; the context evicts by token weight. Nothing
 * connected the two, and they are not independent: every abridged payload
 * still inside the context is a reference the model may follow, so the store
 * must be able to produce every id the context can still be naming. The most
 * references a context can hold is its token limit divided by the cheapest an
 * abridged reference can be — so the capacity is not a free parameter, it is
 * a function of the limit, and a capacity below this makes ids that resolve
 * to nothing REACHABLE rather than merely unlikely. Driven: at a 131,072-token
 * limit against the shipped 256 slots, 95,266 emitted notices named ids the
 * store could no longer produce.
 *
 * The floor is DERIVED from this module's own notice — built over the
 * smallest entry the store will accept — rather than written down, so a
 * reworded notice moves the number with it instead of leaving a stale one
 * behind.
 */
export function minimumLruCapacityForContext(contextTokenLimit: number): number {
  return Math.ceil(contextTokenLimit / cheapestAbridgedReferenceTokens());
}

let cheapestAbridgedTokens: number | undefined;

/** The token weight of the cheapest abridgement this module can produce. */
function cheapestAbridgedReferenceTokens(): number {
  if (cheapestAbridgedTokens !== undefined) return cheapestAbridgedTokens;
  const smallest: ToolResultEntry = deepFreeze({
    // A one-character tool name and a one-character opening: no real entry can
    // be cheaper, so no real context can hold more references than this
    // allows. `id` is a real id from this module's own minting so the width
    // that counts is the width that ships.
    id: `tr-${"0".repeat(ID_HEX_CHARS)}`,
    toolName: "t",
    summary: "x",
    fullResult: "x",
    chunks: [],
    tokensSaved: 0,
    retrievedCount: 0,
    storedAt: 0,
  }) as ToolResultEntry;
  const route = deepFreeze({ toolName: "r" }) as unknown as RetrievalRoute;
  cheapestAbridgedTokens = Math.max(1, estimateTokens(abridgedReference(smallest, route, smallest.fullResult)));
  return cheapestAbridgedTokens;
}

/** Per-tool deterministic summary generator (no LLM). */
export function generateSummary(toolName: string, fullResult: string): string {
  if (fullResult.length === 0) return "";
  if (toolName === "search_code") {
    const lines = fullResult.split("\n").filter((l) => l.length > 0);
    const top = lines.slice(0, 5);
    return `[search_code] ${lines.length} hits. Top: ${top.join(" | ").slice(0, 400)}`;
  }
  if (toolName === "read_file") {
    const lines = fullResult.split("\n");
    const first3 = lines.slice(0, 3).join("\n");
    const last3 = lines.slice(-3).join("\n");
    return `[read_file] ${lines.length} lines. Head:\n${first3}\n...Tail:\n${last3}`;
  }
  if (toolName === "grep") {
    const lines = fullResult.split("\n").filter((l) => l.length > 0);
    const top = lines.slice(0, 5);
    return `[grep] ${lines.length} matches. Top: ${top.join(" | ").slice(0, 400)}`;
  }
  // Generic.
  return `[${toolName}] ${fullResult.slice(0, DEFAULT_MEMORY_PREVIEW_CHARS)}`;
}

/** Chunk a tool result. */
export function chunkToolResult(toolName: string, fullResult: string, cfg: ToolResultConfig): readonly string[] {
  if (fullResult.length === 0) return [];
  if (toolName === "read_file") {
    const lines = fullResult.split("\n");
    const chunks: string[] = [];
    for (let i = 0; i < lines.length; i += cfg.chunkStride) {
      const slice = lines.slice(i, i + cfg.chunkLines).join("\n");
      if (slice.length > 0) chunks.push(slice);
      if (i + cfg.chunkLines >= lines.length) break;
    }
    return chunks;
  }
  const lines = fullResult.split("\n").filter((l) => l.length > 0);
  const chunks: string[] = [];
  for (const line of lines) {
    if (line.length <= cfg.maxChunkChars) {
      chunks.push(line);
    } else {
      for (let i = 0; i < line.length; i += cfg.maxChunkChars) {
        chunks.push(line.slice(i, i + cfg.maxChunkChars));
      }
    }
  }
  return chunks;
}
