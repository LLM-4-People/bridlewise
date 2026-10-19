/**
 * The full-history spectrum feed (§6.6) — connects the LANDED
 * `sweep.spectrum` block through `broker.read` so the band shows the FULL
 * recorded ledger history, not just the session's streamed window.
 *
 * Honesty rules carried here:
 *  - the feed follows what the operator is looking at: an explicit
 *    timeline scope first (what the client-window events follow — a chat,
 *    a project, or one trace's chain), else the open conversation, else the
 *    current project; with NO scope at all there is no read (the block is
 *    chat/project/trace-scoped) and the band
 *    honestly falls back to the streamed window;
 *  - a failed or absent read NEVER fabricates bins — `spectrumWire` simply
 *    stays/returns to null and the client-window fallback (with its honest
 *    "session window" coverage label) stands;
 *  - ONE-REVEAL (§10.3): the feed is started by the mounted Sweep, and a
 *    late-landing payload only repaints the canvas + swaps the text of the
 *    absolutely-positioned coverage overlay — no mount, no geometry change
 *    (guarded in tests/cockpit/sweep-component.test.ts).
 *
 * Refresh is data-driven, never a timer: scope changes refetch; a stream
 * close (run finished) refetches; the block's declared `run:done`
 * invalidation refetches when fired.
 */

import { atom, type ReadableAtom } from "nanostores";

import { onInvalidation, read, readKey } from "../../data/broker.ts";
import { currentChatId } from "../../state/chats.ts";
import { currentProject } from "../../state/projects.ts";
import { timelineScope } from "../../state/timeline-query.ts";
import { decodeSpectrumRead, type SpectrumReadWire } from "./bin-source";
import { streamState } from "./sweep-store";
import type { StreamStatusKind } from "./types";

/** The last successfully read spectrum payload for the CURRENT scope, or
 * null (no scope / not landed / failed) — null means client-window fallback. */
export const spectrumWire: ReadableAtom<SpectrumReadWire | null> = atom<SpectrumReadWire | null>(null);
const spectrumWireW = spectrumWire as ReturnType<typeof atom<SpectrumReadWire | null>>;

/**
 * WHICH scope the held payload answers — "chat" when it is the open
 * conversation's own record, "project"/"trace" for the wider reads, null
 * when nothing has landed. Set beside `spectrumWire` in the same branches,
 * so the two can never disagree about what the bytes on screen describe.
 *
 * A surface that wants to say "this conversation has nothing recorded" may
 * only say it when the record it measured IS the conversation's — an empty
 * PROJECT read or an empty TRACE chain is a different absence with a
 * different subject, and a sentence naming the wrong one would be a guess
 * dressed as a measurement.
 */
export const spectrumScopeKind: ReadableAtom<"chat" | "project" | "trace" | null> =
  atom<"chat" | "project" | "trace" | null>(null);
const spectrumScopeKindW = spectrumScopeKind as ReturnType<
  typeof atom<"chat" | "project" | "trace" | null>
>;

/** Why the band is on the fallback, plain words, or null when the spectrum
 * is live. Surfaces may cite it; they must never invent a nicer story. */
export const spectrumFallbackReason: ReadableAtom<string | null> = atom<string | null>(
  "full history not requested yet",
);
const spectrumFallbackReasonW = spectrumFallbackReason as ReturnType<typeof atom<string | null>>;

/**
 * The Broker cache key of the read that produced `spectrumWire`, or null.
 *
 * The band's LENS stamp reads THIS rather than rebuilding a key from the
 * scope stores, because the two are not the same claim: the scope can change
 * a frame before the new payload lands, and a stamp built from the scope
 * would name a record that has not been written while the pixels on screen
 * still come from the previous one. Set beside `spectrumWire` in the same
 * branch, so the stamp and the bins are always the same read — and cleared
 * with it, so the client-window FALLBACK is honestly unstamped.
 */
export const spectrumProvKey: ReadableAtom<string | null> = atom<string | null>(null);
const spectrumProvKeyW = spectrumProvKey as ReturnType<typeof atom<string | null>>;

/**
 * Resolve the read scope: an explicit timeline scope wins (it is what the
 * client-window events follow); otherwise the OPEN conversation, then the
 * current project — the same "what am I looking at" order the shell uses.
 * Null = genuinely no scope (nothing to read; the fallback says so).
 */
function currentParams(): Record<string, string> | null {
  const scope = timelineScope.get();
  if (scope.kind === "trace" && scope.traceId !== undefined) {
    return { scope: "trace", traceId: scope.traceId };
  }
  if (scope.kind === "chat" && scope.chatId !== undefined) {
    return { scope: "chat", chatId: scope.chatId };
  }
  if (scope.kind === "project" && scope.projectId !== undefined) {
    return { scope: "project", projectId: scope.projectId };
  }
  const chatId = currentChatId.get();
  if (chatId !== null) return { scope: "chat", chatId };
  const project = currentProject.get();
  if (project !== null) return { scope: "project", projectId: project.id };
  return null;
}

let fetchSeq = 0;

/**
 * The cache key of the payload `spectrumWire` currently holds, or null.
 *
 * This is what makes "never blank what you know" decidable HERE. Two things
 * can go wrong with a spectrum read and they deserve opposite answers:
 *
 *   - the QUESTION changed (a different conversation, a different project, no
 *     scope at all) — the bins on screen answer a question nobody is asking
 *     any more, so they must go;
 *   - the SAME question failed to be re-answered — the bins on screen are the
 *     last true answer to the question still being asked, so they stay, with
 *     their own coverage label and their own `asOf`.
 *
 * Blanking in the second case is what made the band flash empty on a hiccup.
 * Comparing keys, rather than tracking a boolean, is what keeps the two cases
 * from being confused when several refreshes overlap.
 */
let heldKey: string | null = null;

/** Fetch the spectrum for the current scope. Exported for tests. */
export async function refreshSpectrum(force = false): Promise<void> {
  const params = currentParams();
  const seq = ++fetchSeq;
  if (params === null) {
    // The question changed to "nothing" — drop what answered the old one.
    heldKey = null;
    spectrumWireW.set(null);
    spectrumProvKeyW.set(null);
    spectrumScopeKindW.set(null);
    spectrumFallbackReasonW.set("no conversation or project scope is open");
    return;
  }
  const key = readKey("sweep.spectrum", params);
  try {
    const wire = await read<SpectrumReadWire>("sweep.spectrum", {
      params,
      invalidateOn: ["run:done"],
      ...(force ? { force: true } : {}),
    });
    if (seq !== fetchSeq) return; // superseded by a newer scope/refresh
    // Validate ONCE at the door: a lying payload throws here (loudly, into
    // the failure branch below) and never reaches the render derivations.
    decodeSpectrumRead(wire);
    heldKey = key;
    spectrumWireW.set(wire);
    spectrumProvKeyW.set(key);
    spectrumScopeKindW.set(
      params.scope === "chat" || params.scope === "project" || params.scope === "trace"
        ? params.scope
        : null,
    );
    spectrumFallbackReasonW.set(null);
  } catch (err) {
    if (seq !== fetchSeq) return;
    // Same scope, failed refresh: the bins standing on screen are still the
    // last true answer to the question being asked. Keep them — and keep the
    // stamp with them, so LENS still names the record they came from (which
    // also carries the Broker's `failed` entry for this attempt).
    if (heldKey === key) return;
    heldKey = null;
    spectrumWireW.set(null);
    spectrumProvKeyW.set(null);
    spectrumScopeKindW.set(null);
    spectrumFallbackReasonW.set(
      `the full-history read failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Start the feed: fetch for the current scope and keep following it.
 * Returns a stop function. Multiple mounted sweeps share one live feed.
 */
let feedCount = 0;
let feedStops: (() => void)[] = [];

export function startSpectrumFeed(): () => void {
  feedCount += 1;
  if (feedCount === 1) {
    let lastScope = timelineScope.get();
    let lastChatId = currentChatId.get();
    let lastProjectId = currentProject.get()?.id ?? null;
    let lastStatus: StreamStatusKind = streamState.get().status;
    void refreshSpectrum();
    feedStops = [
      timelineScope.subscribe((scope) => {
        if (scope === lastScope) return;
        lastScope = scope;
        void refreshSpectrum();
      }),
      currentChatId.subscribe((id) => {
        if (id === lastChatId) return;
        lastChatId = id;
        void refreshSpectrum();
      }),
      currentProject.subscribe((p) => {
        const id = p?.id ?? null;
        if (id === lastProjectId) return;
        lastProjectId = id;
        void refreshSpectrum();
      }),
      streamState.subscribe((s) => {
        // A run finishing (live → closed) means the ledger grew — refetch.
        if (s.status !== lastStatus && s.status === "closed") {
          void refreshSpectrum(true);
        }
        lastStatus = s.status;
      }),
      onInvalidation("run:done", () => {
        void refreshSpectrum();
      }),
    ];
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    feedCount -= 1;
    if (feedCount === 0) {
      for (const stop of feedStops) stop();
      feedStops = [];
    }
  };
}

/** Test/reset seam: drop the payload and reasons to the initial state. */
export function resetSpectrumFeed(): void {
  fetchSeq += 1;
  heldKey = null;
  spectrumWireW.set(null);
  spectrumProvKeyW.set(null);
  spectrumScopeKindW.set(null);
  spectrumFallbackReasonW.set("full history not requested yet");
}
