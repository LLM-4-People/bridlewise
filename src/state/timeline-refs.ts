/**
 * nanostores shared state: timeline refs for the current chat.
 *
 * Plain.ts — Node-testable via Vitest. Fed ONLY by client.ts.
 *
 * Distinct from `./timeline-query.ts`, which queries the canonical
 * timeline ledger via POST /api/timeline/query. This store holds
 * projection refs (event IDs + metadata) loaded per-chat from
 * /api/chats/:id/timeline. The two stores coexist: timeline-query is
 * the forensic surface; timeline-refs is the per-chat chat-scoped view.
 *
 * The TimelineRef type mirrors the server-side
 * `server/routes/views.ts::TimelineRefView`.
 */

import { atom, computed, type ReadableAtom } from "nanostores";

import { registerReset, registerContextReset } from "./store-registry";

// ── Types ──

export type TimelineRef = Readonly<{
  readonly id: string;
  readonly chatId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly timestamp: string;
  readonly metadata: unknown;
}>;

// ── Stores ──

export const timelineRefs = atom<readonly TimelineRef[]>([]);
export const currentTimelineChatId = atom<string | null>(null);

export const timelineRefCount: ReadableAtom<number> = computed(
  timelineRefs,
  (list) => list.length,
);

// ── Ingestion (called only by client.ts) ──

export function setTimelineRefs(list: readonly TimelineRef[]): void {
  timelineRefs.set(list);
}

export function appendTimelineRef(ref: TimelineRef): void {
  timelineRefs.set([...timelineRefs.get(), ref]);
}

export function setCurrentTimelineChatId(id: string | null): void {
  currentTimelineChatId.set(id);
}

export function resetTimelineRefs(): void {
  timelineRefs.set([]);
  currentTimelineChatId.set(null);
}

registerReset("timelineRefs", resetTimelineRefs);
// Also reset on chat switch — timeline refs are per-chat (loaded by
// loadChatHistory). Without this, switching from chat A to chat B leaves
// chat A's refs + currentTimelineChatId on chat B's TimelineInspector
// until chat B's history finishes loading (a brief stale-data flash).
// The reset fires synchronously on currentChatId.set (BEFORE the
// chatId $effect loads the new history), so the inspector briefly shows
// empty (correct — no refs for the new chat yet) then chat B's refs.
registerContextReset("timelineRefs", resetTimelineRefs);
