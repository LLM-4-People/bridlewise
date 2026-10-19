/**
 * Redaction owner — the SINGLE web-UI adapter that wraps the canonical
 * `redactForLLMContext` for every LLM-bound surface.
 *
 * Binding authorities:
 * "Single-Party-Owner Principle": PII redaction has ONE owner
 * module. ALL content going to the LLM goes through it — never bypasses.
 * "Lowest-Level Enforcement": the redaction is applied at the
 * LLM bridge choke point (`streamChat` via `buildLLMMessages` in
 * `llm-bridge.ts`), NOT in each route — so NO caller can forget to
 * redact. A caller that bypasses `buildTrimmedHistory` is still caught
 * at the bridge.
 * "No Scattered Helpers": the redaction helpers live HERE,
 * imported by `context-bridge.ts` + `llm-bridge.ts` (never redefined).
 *
 * This module reuses the canonical privacy/redaction-engine. It adds the web-UI-specific adapters the
 * canonical engine does not own: redacting tool_calls arguments JSON (parse
 * → redact string values → re-stringify so JSON-escaped quotes don't break
 * detection) + redacting a full `ChatMessage` (content + tool_calls args).
 *
 * Layer: web UI server. Owner: privacy-and-redaction (web adapter).
 */

import {
  redactForLLMContext,
  redactMessagesTogether,
  explainRedaction,
  type RedactionExplanation,
} from "../../engine/src/privacy/redaction-engine.ts";
import {
  registerKnownSecret,
  knownSecretLabels,
  knownSecretRegistryGeneration,
} from "../../engine/src/privacy/secret-intelligence.ts";
// The bounded LRU the engine ships — the one implementation of
// re-insert-on-access + evict-oldest, reused here rather than rebuilt
// (No Scattered Helpers).
import { LruCache } from "../../engine/src/memory/unified/cache.ts";
// The single owner of "this token's own grammar explains every byte of it".
// Imported rather than restated so a grammar added there is honoured here
// with no edit — see `redactUserDisplayString`.
import { isBenignToken } from "../../engine/src/privacy/benign-grammars.ts";
// The one authority for "this token is an identifier the exposure registry
// itself minted" — reached through the canonical hub like every other
// harness import, never a direct path into the engine tree.
import { isRegistered } from "../kernel/canonical.ts";
// ONE OWNER FOR "IS THIS KEY NAME SENSITIVE?" — see `isSensitiveKey` below.
import { isSensitiveKeyName } from "../../engine/src/privacy/secret-signals.ts";
import { PII_TYPES } from "../../engine/src/privacy/pii-registry.ts";
import { harnessOwnSecrets } from "../kernel/config.ts";
import { getPrivacyPolicy, getToolCallArgumentsCacheEntries } from "../kernel/harness-config.ts";
import { installRedactionMemoSource } from "../kernel/canonical.ts";
import { webWarn } from "../observability/debug-bridge.ts";
// The canonical chat-message shape, reached through the hub like every other
// canonical import (never a direct path into the harness tree).
import type { ChatMessage } from "../kernel/canonical.ts";
// The resolved policy type the doors below pass through to the engine.
import type { PrivacyPolicy } from "../kernel/canonical.ts";

// ── LAYER 1 WIRING: teaching the redactor its own credentials ────────────

/**
 * THE POLICY IN FORCE for this process's egress, resolved from the config
 * document's `privacy` section. The reader checks current bytes on every
 * acquisition and reuses the resolved policy while that section is unchanged.
 * Each public egress operation acquires once and passes the same policy
 * through its private recursion, so its fields and memo share one input.
 *
 * Every door in this file funnels through it, which is what makes the
 * config section REAL: a written leaf reaches both egress paths (LLM-bound
 * and user-display) through the same resolved object, and a section that
 * would weaken redaction never gets here — it is refused at the write gate
 * and at the resolver. Default-preserving: with no `privacy` section in the
 * document this is the defaults-only policy, byte-identical to the engine's
 * own `DEFAULT_PRIVACY_POLICY`.
 */
function maskerPolicy(): PrivacyPolicy {
  return getPrivacyPolicy();
}

/**
 * Remember a credential THIS SERVER HOLDS so the redactor can recognise it
 * anywhere, in any format, however it has been escaped.
 *
 * The single web-side entry to the engine's private registry — every source
 * of an own-credential (the LLM provider key read from disk, the env-sourced
 * keys) goes through here, so there is one place to look for what the
 * redactor knows and one place that could be wrong about it.
 *
 * Returns whether it was accepted. It does NOT return, log, or throw the
 * value, and neither does the engine: a rejection message that quoted the
 * credential would put it in whatever log caught it, which is the exact
 * failure this layer exists to prevent.
 */
export function rememberOwnCredential(value: unknown, label?: string): boolean {
  const outcome = registerKnownSecret(value, label);
  // NEVER A SILENT REFUSAL (CRED-F3): a credential the registry did not learn
  // is not masked on the surfaces that consult it, so the refusal is logged
  // with its label and reason (never the value) — a full registry, a value
  // under the length floor, one with whitespace.
  if (!outcome.registered) webWarn("llm", "own credential NOT learned by the redactor", () => ({ label: outcome.label, reason: outcome.reason }));
  return outcome.registered;
}

/**
 * Register every credential this process holds that is knowable at startup.
 * Called once from `server/index.ts` before the socket listens, so the
 * identity layer is armed before the first request rather than after the
 * first LLM call. The provider API key is registered separately, at the
 * moment a credential is minted from the database
 * (`providers.ts::mintCredential`), because that mint is also what a rotation
 * goes through — and it is the only way a key can enter this process at all,
 * so registering there means the redactor cannot fail to know a live key.
 *
 * Returns the LABELS registered — never the values — so startup can report
 * what the redactor knows without printing it.
 */
export function primeKnownSecrets(): readonly string[] {
  for (const { label, value } of harnessOwnSecrets()) rememberOwnCredential(value, label);
  return knownSecretLabels();
}

/**
 * WHAT WAS MASKED AND WHY — but only for a redaction THAT ACTUALLY CHANGED
 * SOMETHING, and nothing at all otherwise.
 *
 * A redaction must be explainable, and the two claims this engine can make
 * are not equally strong: "equals the llm-provider-api-key this server holds"
 * is PROVEN, and "follows the phrase 'api key' and has the shape of a
 * credential" is INFERRED. Each explanation carries its `confidence` so a
 * surface can show the difference instead of presenting a guess with the
 * authority of a fact. None of them carries any substring of the original: a
 * preview of a masked secret is the secret.
 *
 * Two properties, both deliberate. It is cheap: the detector runs a second
 * time only for strings whose redacted form differs from the original, which
 * is the rare case — a payload with no secrets pays one string comparison and
 * nothing else. And it cannot report a redaction that did not happen: the
 * comparison, not the detector, is what decides there is anything to say, so
 * a span that was detected but fell outside the applied spans can never
 * produce a phantom entry in the user's list.
 */
export function explainIfMasked(original: string, redacted: string): readonly RedactionExplanation[] {
  if (original === redacted) return NO_EXPLANATIONS;
  return explainRedaction(original, maskerPolicy());
}

const NO_EXPLANATIONS: readonly RedactionExplanation[] = Object.freeze([]);

/**
 * Which tier a detection belongs to, joined from the PII registry by the
 * signal id the span carries.
 *
 * Derived rather than tabulated: a new type declared in the registry reports
 * under its tier here with no edit, and a type that is removed cannot leave
 * a stale row behind.
 */
const TIER_BY_SIGNAL: ReadonlyMap<string, string> = new Map(
  PII_TYPES.map((type) => [type.id, type.tier] as const),
);

function tierOfDetection(signalId: string): string | null {
  return TIER_BY_SIGNAL.get(signalId) ?? null;
}

/**
 * WHAT THE USER IS TOLD when the model's input was changed on their behalf.
 *
 * Counted by confidence, because "1 value matched a credential this server
 * holds" and "1 value looked like a credential after the words 'api key is'"
 * are different things to be told, and a single number would flatten them
 * into the same claim.
 */
export type RedactionNotice = Readonly<{
  maskedCount: number;
  proven: number;
  format: number;
  inferred: number;
  /**
   * VALUES THAT WERE ALREADY MASKED BEFORE THIS POINT, and for which no
   * reason can honestly be given.
   *
   * `buildTrimmedHistory` redacts the conversation history on its way out of
   * the context manager, so by the time the choke point sees a history
   * message the secret is already `[REDACTED:…]` and the ORIGINAL is gone.
   * The choke point can count those markers; it cannot say why each one is
   * there, because it never saw what was underneath.
   *
   * Reported as its own number rather than folded into `maskedCount`. Adding
   * them together would attach the confidence of the spans this pass
   * explained to spans it knows nothing about — which is precisely the
   * dishonesty the confidence split exists to prevent. A surface can say "3
   * values were hidden here, and 2 more had already been hidden upstream",
   * which is true, instead of "5 values were hidden, here is why", which is
   * not.
   */
  maskedUpstream: number;
  /**
   * HOW MANY VALUES EACH TIER FOUND, keyed by the tier id the registry
   * declares.
   *
   * Carried on the EXISTING event rather than on a second channel. A user
   * looking at "4 values hidden" and wanting to switch something off needs
   * to know WHICH switch, and the confidence split does not answer that —
   * `inferred` covers both the randomness tier and the declaration tier, and
   * they are turned off separately.
   */
  byTier: Readonly<Record<string, number>>;
  reasons: readonly Readonly<{
    confidence: RedactionExplanation["confidence"];
    category: RedactionExplanation["category"];
    maskedLength: number;
    explanation: string;
  }>[];
}>;

/** How many individual reasons a notice carries. A pasted config can trip
 * hundreds of spans, and the point of the notice is to be read. */
export const REDACTION_NOTICE_MAX_REASONS = 20;

/**
 * Fold per-string explanations into the one notice a turn reports. Returns
 * null when nothing was masked — the caller must not emit a "0 values were
 * hidden" event, which is noise that trains a user to ignore the channel that
 * matters.
 */
/** How many values a text already carries as redaction markers. The marker
 * cannot occur inside a detected secret, which is the same fact the engine's
 * idempotence rests on. Read from the RESOLVED policy, never the built-in
 * spelling: the producer masks under whatever marker the config resolved,
 * and a counter that hardcodes `[REDACTED:` would read a changed marker as
 * "nothing was masked" — the same producer/consumer split that once made
 * the engine's own marker recogniser certify its output as a residual
 * secret. */
export function countMaskedValues(text: string, policy: PrivacyPolicy = maskerPolicy()): number {
  return countRedactionMarkers(text, policy);
}

export function summarizeRedactions(
  explanations: readonly RedactionExplanation[],
  maskedUpstream = 0,
): RedactionNotice | null {
  if (explanations.length === 0 && maskedUpstream === 0) return null;
  let proven = 0, format = 0, inferred = 0;
  const byTier: Record<string, number> = {};
  for (const e of explanations) {
    if (e.confidence === "proven") proven += 1;
    else if (e.confidence === "format") format += 1;
    else inferred += 1;
    // The tier is RESOLVED from the registry by the signal id the span
    // carries, never restated here — the same join the settings surface
    // makes, so a switch a user flips and a count they read name one thing.
    const tier = tierOfDetection(e.signalId);
    if (tier !== null) byTier[tier] = (byTier[tier] ?? 0) + 1;
  }
  return Object.freeze({
    maskedCount: explanations.length,
    proven,
    format,
    inferred,
    maskedUpstream,
    byTier: Object.freeze(byTier),
    reasons: Object.freeze(
      explanations.slice(0, REDACTION_NOTICE_MAX_REASONS).map((e) => Object.freeze({
        confidence: e.confidence,
        category: e.category,
        maskedLength: e.maskedLength,
        explanation: e.explanation,
      })),
    ),
  });
}

/**
 * Redact sensitive values from a string before it reaches the LLM.
 * Reuses the canonical `redactForLLMContext` — the single detection engine —
 * under the RESOLVED policy (the config document's `privacy` section, or
 * the defaults when it is absent). The variable/const/env NAME is
 * preserved; only the secret VALUE is masked
 * (`const API_KEY = "sk-..."` → `const API_KEY = "[REDACTED:credential]"`).
 */
export function redactContent(text: string): string {
  return redactForLLMContext(text, maskerPolicy());
}

/**
 * Redact a whole turn's worth of text TOGETHER, so a credential the user
 * declared in one message is masked in every other one.
 *
 * The web-side door onto `redactMessagesTogether`. Reuses the canonical
 * engine — it is not a second detector, it is the same detector told about
 * the whole conversation instead of one message at a time.
 *
 * Returns redacted texts or projected messages in the same order, and how
 * many values were learned. Parsed arguments share the canonical turn's
 * learned context within this call; no learned values escape the adapter.
 */
export function redactTurnTogether(texts: readonly string[]): Readonly<{ redacted: readonly string[]; learnedCount: number }>;
export function redactTurnTogether(messages: readonly ChatMessage[]): Readonly<{ redacted: readonly ChatMessage[]; learnedCount: number }>;
export function redactTurnTogether(input: readonly string[] | readonly ChatMessage[]): Readonly<{ redacted: readonly string[] | readonly ChatMessage[]; learnedCount: number }> {
  const policy = maskerPolicy();
  const texts = input.map((item) => typeof item === "string" ? item : item.content);
  const turn = redactMessagesTogether(texts, policy);
  if (input.length === 0 || typeof input[0] === "string") {
    return { redacted: turn.redacted, learnedCount: turn.learnedCount };
  }
  // Learned values belong to this turn only. Contextual argument results
  // must neither read nor populate the global raw/policy/registry memo.
  const contextualRedact = turn.learnedCount > 0 ? turn.redact : undefined;
  return {
    redacted: (input as readonly ChatMessage[]).map((msg, index) =>
      redactMessageWithContent(msg, turn.redacted[index]!, policy, contextualRedact)),
    learnedCount: turn.learnedCount,
  };
}

/**
 * Redact sensitive values from tool_calls arguments (a JSON string). The
 * arguments are PARSED first so JSON-escaped quotes (`\"`) are unescaped
 * before detection — otherwise the credential-assignment regex would miss
 * `{"content":"const API_KEY = \"sk-...\""}` because the backslash breaks
 * the `["']?` delimiter match. Each string VALUE in the parsed object is
 * redacted; non-string leaves (numbers, booleans, null) pass through. The
 * redacted object is re-stringified so the JSON structure stays valid.
 * Falls back to raw text redaction when the arguments are not valid JSON.
 *
 * THE MEMO. Loops, retries and parallel batches replay byte-identical
 * argument payloads, and every one of N identical calls used to pay the
 * full parse → walk-redact → re-stringify. The function's output is
 * determined by the exact input string plus two resolved inputs: the
 * known-secret registry's generation and the PRIVACY POLICY in force (the
 * marker and the shape flags change what the redacted copy looks like), so
 * the memo is content-addressed on the input and invalidated when either
 * resolved input changes. A registry mutation (a credential registered,
 * rotated or cleared) and a config edit that resolves a different policy
 * (the current config bytes change, the reader re-parses, the policy
 * object's reference changes) are both real input changes, and each empties
 * the memo at the next call — a payload memoised before the process
 * learned a secret or changed its marker is never served after it did.
 * Bounded at `redaction.toolCallArgumentsCacheEntries` with LRU eviction so
 * the memo cannot grow with the run.
 */
const toolCallArgumentsMemo = new LruCache<string, string>(getToolCallArgumentsCacheEntries());
let toolCallArgumentsMemoGeneration = knownSecretRegistryGeneration();
let toolCallArgumentsMemoPolicy: PrivacyPolicy | undefined;
let toolCallArgumentsMemoHits = 0;
let toolCallArgumentsMemoMisses = 0;

/**
 * How the tool-call-arguments memo is doing: entries held (never above the
 * configured bound), replays served without re-detecting, and payloads
 * actually processed. The only readers are observability and the exposure
 * surface's installable source — the counts are facts about the memo,
 * never about what it holds.
 */
export function toolCallArgumentsMemoStats(): Readonly<{ entries: number; hits: number; misses: number }> {
  return Object.freeze({
    entries: toolCallArgumentsMemo.size,
    hits: toolCallArgumentsMemoHits,
    misses: toolCallArgumentsMemoMisses,
  });
}

// The settings room's `redaction` category serves the store's live
// occupancy as a signal through an installable source (the performance
// module's metrics-source pattern): this module owns the counters, so it
// is the one that installs them, and the registration reads them through
// the hub — no second measurement path.
installRedactionMemoSource(() => ({ entries: toolCallArgumentsMemoStats().entries }));

export function redactToolCallArguments(raw: string): string {
  if (raw.length === 0) return raw;
  return redactToolCallArgumentsWithPolicy(raw, maskerPolicy());
}

// The public argument door and the composed message door share this body;
// the latter already owns a policy for its content and must keep it here.
function redactToolCallArgumentsWithPolicy(raw: string, policy: PrivacyPolicy, contextualRedact?: (text: string) => string): string {
  if (raw.length === 0) return raw;
  const generation = knownSecretRegistryGeneration();
  if (generation !== toolCallArgumentsMemoGeneration || toolCallArgumentsMemoPolicy !== policy) {
    toolCallArgumentsMemo.clear();
    toolCallArgumentsMemoGeneration = generation;
    toolCallArgumentsMemoPolicy = policy;
  }
  const memoised = contextualRedact === undefined ? toolCallArgumentsMemo.get(raw) : undefined;
  if (memoised !== undefined) {
    toolCallArgumentsMemoHits += 1;
    return memoised;
  }
  if (contextualRedact === undefined) toolCallArgumentsMemoMisses += 1;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const redacted = contextualRedact === undefined ? redactForLLMContext(raw, policy) : contextualRedact(raw);
    if (contextualRedact === undefined) toolCallArgumentsMemo.set(raw, redacted);
    return redacted;
  }
  const redacted = JSON.stringify(redactStringValuesDeep(parsed, new WeakMap(), policy, contextualRedact));
  if (contextualRedact === undefined) toolCallArgumentsMemo.set(raw, redacted);
  return redacted;
}

/**
 * Whether a value is a PLAIN object (prototype is `Object.prototype` or
 * `null`) — not a built-in like Date, Map, Set, RegExp, Error, ArrayBuffer.
 * The redaction walkers only recurse into plain objects so built-in objects
 * are preserved (JSON.stringify serializes them natively — a Date → ISO
 * string — instead of being destroyed into `{}` because they have no
 * enumerable own properties). Shared by all three walkers (No Scattered
 * Helpers — the plain-object check has one owner).
 */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

/**
 * Recursively redact every string VALUE in a parsed JSON structure. Object
 * KEYS are preserved (they are identifiers, not secret values — keep
 * consts/vars/env names). Non-string leaves pass through unchanged. Built-in
 * objects (Date, Map, Set, RegExp) are preserved as-is so JSON.stringify
 * serializes them natively. Revisited objects return their redacted clone:
 * aliases remain safe to serialize, and true cycles remain cycles for JSON's
 * normal TypeError. The operation-local association is installed before
 * descent, so no branch can return an unredacted original on a revisit.
 */
export function redactStringValues(value: unknown): unknown {
  return redactStringValuesDeep(value, new WeakMap(), maskerPolicy());
}

function redactStringValuesDeep(value: unknown, seen: WeakMap<object, unknown>, policy: PrivacyPolicy, contextualRedact?: (text: string) => string): unknown {
  if (typeof value === "string") return contextualRedact === undefined ? redactForLLMContext(value, policy) : contextualRedact(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return seen.get(value);
    const out: unknown[] = new Array(value.length);
    seen.set(value, out);
    value.forEach((v, i) => { out[i] = redactStringValuesDeep(v, seen, policy, contextualRedact); });
    return out;
  }
  if (value !== null && typeof value === "object") {
    if (!isPlainObject(value as object)) return value;
    if (seen.has(value)) return seen.get(value);
    const out: Record<string, unknown> = {};
    seen.set(value, out);
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactStringValuesDeep(v, seen, policy, contextualRedact);
    return out;
  }
  return value;
}

/**
 * Redact sensitive VALUES from an arbitrary user-facing payload before it
 * leaves the server for the browser. This is the USER-DISPLAY choke-point
 * adapter: it recursively walks the payload (object, array, or string) and
 * masks every secret VALUE via the canonical `redactContent` engine —
 * preserving all keys, structure, numbers, and booleans, so the UI still
 * renders correctly and the variable/const/env NAMES survive. A payload
 * with no secrets is returned unchanged (no false positives).
 *
 * JSON-aware string redaction: a tool argument / result can be a JSON
 * STRING with JSON-escaped quotes (`\"`), which breaks credential-
 * assignment detection in a plain-text pass (the backslash before the
 * quote defeats the `["']?` delimiter match). For any string that looks
 * like JSON, this walker PARSES it first, redacts the string values within
 * the parsed structure (reusing `redactStringValues`), and re-stringifies —
 * so an escaped secret like `{"content":"const API_KEY = \"sk-...\""}` is
 * caught. Non-JSON strings keep the plain `redactContent` pass. This is a
 * superset for JSON strings; the LLM-bound path handles the same case via
 * `redactToolCallArguments` (field-aware); the user-display path is
 * field-agnostic so it applies the JSON-aware pass to every JSON-looking
 * string value (defense-in-depth — a future tool that returns a JSON
 * string with secrets is covered without a per-field change).
 *
 * Single-Party-Owner: this reuses the canonical engine and string-value walk
 * (the same detection engine the LLM-bound path uses) — it is NOT a second
 * detector. The LLM path redacts at `buildLLMMessages`; the USER-DISPLAY
 * path redacts at the SSE `send` choke point + the view mappers. Both call
 * THIS owner, so a caller that bypasses an upstream redaction is still
 * caught at the egress choke point (PII must be redacted before sending to
 * the LLM AND before showing to the user).
 */
export function redactForUserDisplay(data: unknown): unknown {
  // Cycle-safe: a payload with a circular reference (e.g. a cache object
  // that references itself) would otherwise infinite-loop the recursive
  // walker and crash the egress choke point with a stack overflow BEFORE
  // JSON.stringify runs (a RangeError, which is harder to recover from
  // than the clean TypeError JSON.stringify throws on cycles). The
  // `seen` maps each input to its redacted clone. Returning that clone on
  // a revisit preserves aliases and makes JSON.stringify report cycles (which
  // the router maps to 500) instead of a stack-overflow crash. This is the
  // egress choke point — every REST response passes through it, so it must
  // not crash on adversarial or accidental cyclic payloads.
  return redactUserDisplayValue(data, new WeakMap(), maskerPolicy());
}

/**
 * Would the user-display egress hide any part of this value?
 *
 * The settings surfaces need to know when the wire serves a value in its
 * MASKED form: a read-back whose served value is `[REDACTED:token]`-shaped
 * is a successful save's proof, not a mismatch — and a masked literal must
 * never travel back into an editable field, or an edit would write the mask
 * itself as data. The caller could not answer that question client-side:
 * the marker spelling is a RESOLVED policy fact (configurable), and a
 * consumer that pattern-matched a hardcoded `[REDACTED:` would read a
 * configured marker as an ordinary value — the same producer/consumer split
 * the policy owner documents for the marker default.
 *
 * So the answer is derived HERE, from the SAME walk the egress runs, in the
 * same process with the same resolved policy — the flag and the masking
 * cannot disagree by construction. Strings are the only shape the walk can
 * change; numbers and booleans are never masked, so they answer false
 * without paying the walk. Objects compare through their serialized forms:
 * the walk rebuilds a plain object key-order-identically (only string leaves
 * change), so a byte difference means something was masked — never a
 * formatting artifact.
 */
export function isHiddenFromUserDisplay(value: unknown): boolean {
  if (typeof value === "string") {
    return redactUserDisplayString(value, maskerPolicy()) !== value;
  }
  if (Array.isArray(value) || (value !== null && typeof value === "object")) {
    try {
      return JSON.stringify(redactForUserDisplay(value)) !== JSON.stringify(value);
    } catch {
      // A cyclic structure cannot reach the wire as a customization value
      // (the wire is JSON); an unserializable input answers "nothing was
      // hidden", the honest floor.
      return false;
    }
  }
  return false;
}

/**
 * A KEY WHOSE VALUE THIS SERVER ISSUED AS A POSITION, not as content.
 *
 * THE BREAK THIS CLOSES, found by the paging guard rather than by reasoning.
 * A history cursor is base64url of `<created_at>:<rowid>` — 54 unbroken
 * random-looking characters explained by no ordinary grammar, which is the
 * exact definition the value-intrinsic layer uses. So the egress choke point
 * masked it, the client sent `[REDACTED:credential]` back as its next
 * `before=`, and walking a conversation backwards stopped working. The
 * redactor had eaten the product's own pagination.
 *
 * The general fact is worth stating because it will recur: INVERTING THE
 * ENUMERATION MAKES EVERY OPAQUE SERVER-ISSUED TOKEN A CANDIDATE. Anything
 * this server mints and expects to receive back — a cursor today, an etag or
 * a continuation token tomorrow — has a credential's shape and none of its
 * meaning.
 *
 * The exemption is by KEY and it is deliberately tiny and deliberately
 * shaped: `cursor`, or something-`Cursor`. A cursor is by contract the
 * server's own position in the caller's own data (`server/db/schema.ts`
 * says so), never user content, so there is nothing here for a redactor to
 * protect. It applies to the USER-DISPLAY walk only — the LLM-bound path
 * redacts message content, where every string is the user's and none of them
 * is an envelope.
 *
 * Held by `tests/prevention/pii-redaction-user-display.test.ts`, which fails
 * if this grows to cover a key that could carry content.
 */
export function isServerIssuedPositionKey(key: string): boolean {
  return /^(?:older|newer|next|prev|previous)?[Cc]ursor$/u.test(key);
}

function redactUserDisplayValue(value: unknown, seen: WeakMap<object, unknown>, policy: PrivacyPolicy): unknown {
  if (typeof value === "string") return redactUserDisplayString(value, policy);
  if (Array.isArray(value)) {
    if (seen.has(value)) return seen.get(value);
    const out: unknown[] = new Array(value.length);
    seen.set(value, out);
    value.forEach((v, i) => { out[i] = redactUserDisplayValue(v, seen, policy); });
    return out;
  }
  if (value !== null && typeof value === "object") {
    // Only walk PLAIN objects (prototype is Object.prototype or null).
    // Built-in objects (Date, Map, Set, RegExp, Error, ArrayBuffer, etc.)
    // are returned as-is so JSON.stringify produces their native
    // representation (e.g. a Date → ISO string) instead of being destroyed
    // into `{}` (Date has no enumerable own props). This preserves data
    // fidelity for any route that returns a built-in object via the egress
    // choke point.
    if (!isPlainObject(value as object)) return value;
    if (seen.has(value)) return seen.get(value);
    const out: Record<string, unknown> = {};
    seen.set(value, out);
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // A cursor is this server's own position handed back to it. See
      // `isServerIssuedPositionKey` for the break that made this necessary.
      out[k] = typeof v === "string" && isServerIssuedPositionKey(k)
        ? v
        : redactUserDisplayValue(v, seen, policy);
    }
    return out;
  }
  return value;
}

/**
 * Redact a single user-facing string. Applies the plain-text pass first
 * (catches secrets in file contents, model deltas, system prompts, error
 * messages — the common case). Then, if the string looks like a JSON
 * object/array, parses it + redacts within + re-stringifies so JSON-
 * escaped quotes (`\"`) don't hide credential-assignment secrets (the
 * `toolResult.arguments` case). The JSON-aware result is preferred ONLY
 * when it masked something the plain pass missed — otherwise the plain
 * result is returned to preserve the original formatting (avoid spurious
 * re-stringification of JSON strings that carry no secrets).
 */
function redactUserDisplayString(text: string, policy: PrivacyPolicy): string {
  if (text.length === 0) return text;
  // ── AN IDENTIFIER IS NOT CONTENT, AND MASKING PART OF ONE IS THE WORST OF
  // BOTH OUTCOMES ─────────────────────────────────────────────────────────
  //
  // Every id this server hands the browser — message, chat, project, run,
  // event, tool-call — is a UUID, and a UUID whose fourth group happens to
  // read `9acc` was going out as
  // `b476afda-3d57-45c8-9acc-[REDACTED:credential]`. `acc` is a derived
  // abbreviation of `access`, so the detector read the hex digits INSIDE the
  // identifier as a credential noun and masked the twelve characters after
  // it. It hides nothing (the first twenty-four characters still ship) and
  // it destroys the key the client has to send back: a rewind, a page cursor
  // or a jump addressed at that id fails with "not found" against a record
  // that is right there. Measured at 0.04% of random UUIDs, which is a
  // handful per long conversation and therefore an intermittent, unownable
  // bug rather than a reproducible one.
  //
  // The rule is the benign-grammar inversion this project already relies on,
  // applied one level up: a leaf whose ENTIRE text one benign grammar
  // explains (a UUID, a digest, a git SHA, an ISO timestamp) is structure,
  // not prose. Nothing is lost by passing it through — such a token is
  // already vetoed as a value-intrinsic candidate, so the only detection
  // that can fire on it is one whose cue lies inside the token itself, which
  // is precisely the false reading above. A leaf carrying an actual secret
  // (`sk-live-…`, `accessToken=…`) matches no benign grammar and is masked
  // exactly as before.
  //
  // Deliberately NOT a list of id-shaped KEY names. `isServerIssuedPositionKey`
  // below is one of those, added when the same corruption hit the paging
  // cursor, and it protects only the keys someone remembered. This is a
  // property of the VALUE, so a field added tomorrow is covered without an
  // edit — and the grammars it defers to have one owner.
  if (isBenignToken(text)) return text;
  const plain = redactForLLMContext(text, policy);
  // ── A LEAF THAT IS AN IDENTIFIER THIS SERVER'S OWN REGISTRY MINTED IS NOT
  // CONTENT, AND MASKING IT DESTROYS THE WRITE IT EXISTS TO SERVE ──────────
  //
  // The settings wires are the measured instance. A customization id is a
  // `module.name` token the exposure registry authored — and the id
  // `graph.slowLlmMsThreshold` read as "18 unbroken random-looking
  // characters" to the value-intrinsic layer, because its camelCase segment
  // (`slow` + `Llm` + one-letter `Ms` + `Threshold`) matches no benign
  // grammar and carries too few vowels to read as words. So BOTH served
  // wires shipped it masked, the row's Save verb posted
  // `{"id":"[REDACTED:credential]"}` back, and the server answered a 404
  // against an id it had minted itself — an adjustable-looking settings row
  // that was structurally unwritable. This is the cursor class again: a
  // token this server issues and expects back has a credential's shape and
  // none of its meaning.
  //
  // The exemption is by AUTHORSHIP and it is deliberately exact: the leaf
  // must byte-equal an id the LIVE registry holds. That is provably narrower
  // than any alternative:
  //  - narrower than a key-name exemption, which would pass whatever sits
  //    under a key (`{id: "sk-…"}` would leak); this passes only strings the
  //    registry itself minted, whatever field they sit in;
  //  - narrower than a benign-grammar for dotted ids, which would have to
  //    accept a SHAPE — and every shape that admits this token moves toward
  //    the random-alphabet bypass the grammar table's own guards exist to
  //    close (dot-separated segments are also the JWT wire shape); the
  //    engine stays byte-identical, so the LLM-bound path keeps masking the
  //    same token in message content, where every string is the user's;
  //  - dynamic and deny-by-default, because the answer is consulted from
  //    the registry — the mint — never restated here: a customization
  //    registered tomorrow is exempt the day it lands, and a lookalike id
  //    the registry does not hold gets no exemption at all.
  // A user-typed value can never collide with this: the only strings it
  // passes are the registry's own dotted identifiers, which are public
  // settings vocabulary, not secrets. The check runs only when the detector
  // already masked something, so a clean payload pays nothing.
  if (plain !== text && isRegistered(text)) return text;
  // Fast path: if the string does not look like a JSON object/array, the
  // plain pass is authoritative (no escaped-quote risk).
  const first = text.charCodeAt(0);
  if (first !== 123 /* { */ && first !== 91 /* [ */) return plain;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return plain;
  }
  const inner = redactStringValuesDeep(parsed, new WeakMap(), policy);
  const jsonAware = JSON.stringify(inner);
  // ── PREFER WHICHEVER MASKED MORE, not whichever masked FIRST ────────────
  //
  // This used to read `jsonAware.includes("[REDACTED:") &&
  // !plain.includes("[REDACTED:")`, i.e. "take the JSON-aware result only if
  // the plain pass found NOTHING". One plainly-visible secret in the same
  // string therefore suppressed the JSON-aware pass entirely, and every
  // escaped secret beside it went out unmasked. Measured, at the egress
  // choke point:
  //
  //   in   {"note":"sk_aaaa…","code":"const password = \"zzzz…\""}
  //   out  {"note":"[REDACTED:token]","code":"const password = \"zzzz…\""}
  //
  // The token was masked, so the credential was not even looked for.
  //
  // Counting markers is MONOTONE with respect to the old rule: when the
  // plain pass found nothing, `jsonMarks > 0 = plainMarks` still selects the
  // JSON-aware result, so this can only ever mask MORE than before, never
  // less. On a tie the plain result wins, which keeps the original
  // formatting for the common case where both passes found the same thing.
  const plainMarks = countRedactionMarkers(plain, policy);
  const jsonMarks = countRedactionMarkers(jsonAware, policy);
  if (jsonMarks > plainMarks) return jsonAware;
  return plain;
}

/** How many values a pass masked. The marker is the RESOLVED policy's own
 * `prefix` (the producer masks under the same spelling), which cannot occur
 * in a detected secret — the detector's own idempotence rests on the same
 * fact. Reading the built-in spelling here would count a configured marker
 * as "nothing was masked" and let the plain pass win every tiebreak, which
 * is exactly how the escaped-secret leak this tiebreak exists to close would
 * come back. */
function countRedactionMarkers(text: string, policy: PrivacyPolicy): number {
  const marker = policy.redactionPrefix;
  let count = 0;
  let at = text.indexOf(marker);
  while (at !== -1) {
    count += 1;
    at = text.indexOf(marker, at + 1);
  }
  return count;
}

/**
 * The marker used by the key-based redaction (`redactBySensitiveKeys`).
 * Distinct from the value-pattern marker (`[REDACTED:credential]`) so a
 * reader can tell whether a value was masked because its KEY name was
 * sensitive (`[redacted]`) or because its VALUE matched a credential
 * pattern (`[REDACTED:credential]`). The two strategies are complementary
 * and composable: key-based catches secrets under sensitive-named keys
 * whose value may not match a credential pattern (e.g. a GitHub PAT
 * `ghp_...` stored under `authToken`); value-pattern catches secrets in
 * arbitrary content regardless of key name.
 */
const REDACTED_BY_KEY = "[redacted]";

/**
 * Whether a config key name is sensitive — used by the config PUT route to
 * REJECT writes to sensitive keys, and by `redactBySensitiveKeys` to decide
 * which subtrees to mask.
 *
 * ── IT KEPT ITS OWN LIST, AND THE TWO LISTS DISAGREED ─────────────────────
 *
 * This was a private array of six regexes, and the harness has a catalogue
 * answering the same question. Neither contained the other. Measured on this
 * one: `apiKey`, `accessToken`, `auth` and `password` were sensitive, and
 * `authorization`, `Authorization`, `cookie`, `privateKey`, `passphrase` and
 * `bearer` were NOT — while the harness's catalogue had `authorization`,
 * `cookie` and `privatekey` and lacked bare `token`. Two owners of one fact is
 * the bug; picking the better one and leaving the other is not the fix.
 *
 * So the catalogue is collapsed into the harness's `secret-signals.ts` and
 * this function delegates. It stays exported because the two consumers here
 * are this module's own redactor and the config route, and neither should
 * reach past the redaction owner for a redaction decision.
 */
export function isSensitiveKey(key: string): boolean {
  return isSensitiveKeyName(key);
}

/**
 * Redact ALL string leaf values under a subtree (deny-by-default for a
 * sensitive-key subtree: a sensitive key like `auth` may contain secrets
 * under non-sensitive-named nested keys, e.g. `auth: { github: "sk-..." }`;
 * recursing with only the nested-key check would leak those). Non-string
 * leaves (numbers, booleans, arrays of non-strings) are preserved so the
 * structure stays visible for debugging. Built-in objects (Date, Map, Set)
 * are preserved as-is; the walker is cycle-safe.
 */
function redactStringsDeepByKey(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === "string") return REDACTED_BY_KEY;
  if (Array.isArray(value)) {
    if (seen.has(value)) return seen.get(value);
    const out: unknown[] = new Array(value.length);
    seen.set(value, out);
    value.forEach((v, i) => { out[i] = redactStringsDeepByKey(v, seen); });
    return out;
  }
  if (value === null || typeof value !== "object") return value;
  if (!isPlainObject(value)) return value;
  if (seen.has(value)) return seen.get(value);
  const obj = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  seen.set(value, result);
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === "string") result[key] = REDACTED_BY_KEY;
    else result[key] = redactStringsDeepByKey(val, seen);
  }
  return result;
}

/**
 * Redact a structured payload by SENSITIVE KEY NAME (complementary to the
 * value-pattern `redactContent`). When the key is sensitive, ALL string
 * leaf values under it are redacted regardless of the nested key names
 * (deny-by-default for the subtree). When the key is not sensitive, the
 * subtree is walked and the same key-based rule is applied recursively.
 * Non-string leaves are preserved so the structure stays visible.
 *
 * Single-Party-Owner: the key-based redaction lives HERE (the redaction
 * owner), NOT in each route. The config route imports this — it does not
 * redefine the key patterns or the deep walker (No Scattered Helpers).
 * This is the strategy appropriate for STRUCTURED config snapshots (where
 * key names are known and authoritative); the value-pattern
 * `redactForUserDisplay` is the strategy for ARBITRARY content (file
 * contents, chat messages, tool results). Both live in this one owner.
 * Built-in objects (Date, Map, Set) are preserved as-is; the walker is
 * cycle-safe.
 */
export function redactBySensitiveKeys(value: unknown): unknown {
  // A normal subtree and an all-string-sensitive subtree can share an input
  // object but require different outputs. Keep each context's association
  // separate, within this call only, so traversal order cannot weaken a mask.
  return redactBySensitiveKeysDeep(value, new WeakMap(), new WeakMap());
}

function redactBySensitiveKeysDeep(value: unknown, seen: WeakMap<object, unknown>, sensitiveSeen: WeakMap<object, unknown>): unknown {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    if (seen.has(value)) return seen.get(value);
    const out: unknown[] = new Array(value.length);
    seen.set(value, out);
    value.forEach((v, i) => { out[i] = redactBySensitiveKeysDeep(v, seen, sensitiveSeen); });
    return out;
  }
  if (!isPlainObject(value)) return value;
  if (seen.has(value)) return seen.get(value);
  const obj = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  seen.set(value, result);
  for (const [key, val] of Object.entries(obj)) {
    result[key] = isSensitiveKey(key)
      ? redactStringsDeepByKey(val, sensitiveSeen)
      : redactBySensitiveKeysDeep(val, seen, sensitiveSeen);
  }
  return result;
}

/** The runtime shape of a tool_calls element. The canonical `ChatMessage`
 * types `tool_calls` as `readonly unknown[]`; this narrows it for redaction
 * so the function/arguments fields are typed. */
type ToolCallElement = Readonly<{
  id: string;
  type: "function";
  function: Readonly<{ name: string; arguments: string }>;
}>;

/**
 * Redact sensitive values from a single `ChatMessage` (content + each
 * tool_calls argument JSON). The role, tool_call_id, name, tool call id, and
 * function name are preserved (they are identifiers, not secrets). Only the
 * content + the tool_calls argument VALUES are masked. This is the per-
 * message redaction the LLM bridge choke point (`buildLLMMessages`) applies
 * to every history message so no caller can leak a secret by passing a raw
 * history that bypassed `buildTrimmedHistory`.
 */
export function redactMessage(msg: ChatMessage): ChatMessage {
  const policy = maskerPolicy();
  return redactMessageWithContent(msg, redactForLLMContext(msg.content, policy), policy);
}

// Only this owner supplies already-redacted content, from either the single
// message pass or the canonical turn pass. Keep the allowed-field projection
// in one place; arbitrary raw metadata must never enter the output.
function redactMessageWithContent(msg: ChatMessage, content: string, policy: PrivacyPolicy, contextualRedact?: (text: string) => string): ChatMessage {
  const out: {
    role: ChatMessage["role"];
    content: string;
    name?: string;
    tool_call_id?: string;
    tool_calls?: readonly unknown[];
  } = { role: msg.role, content };
  if (msg.name !== undefined) out.name = msg.name;
  if (msg.tool_call_id !== undefined) out.tool_call_id = msg.tool_call_id;
  if (msg.tool_calls !== undefined && msg.tool_calls.length > 0) {
    out.tool_calls = (msg.tool_calls as readonly ToolCallElement[]).map((tc) => ({
      id: tc.id,
      type: tc.type,
      function: { name: tc.function.name, arguments: redactToolCallArgumentsWithPolicy(tc.function.arguments, policy, contextualRedact) },
    }));
  }
  return out;
}
