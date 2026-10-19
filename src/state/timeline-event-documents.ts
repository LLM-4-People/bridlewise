/**
 * nanostores shared state: the recorded DOCUMENTS of a canonical timeline
 * event — the payload the event's beat can unfold in the SCOPE sheet.
 *
 * Plain.ts — Node-testable via Vitest. The live reader is the network
 * door (`GET /api/timeline/events/:eventId` — the detail door that adds
 * what the list reads elide); it is INJECTABLE so tests own the response
 * without touching the network (the run-pane/custody-feed pattern).
 *
 * HONESTY RULES, the response grammar's own:
 *   - a fold that has not been opened has NOT read: absence, no spinner,
 *     no invented empty list;
 *   - a 404 is the door's deny-by-default (an event that is not the
 *     caller's, or no longer exists): a stated absence, never an error
 *     banner on a record the user is reading;
 *   - a document's display content is parsed when possible, rendered through
 *     the render layer's public JSON door — never prose-summarized here.
 *
 * @global-store per-event fold state, reset with the store registry.
 */

import { atom } from "nanostores";

import { fetchJson } from "../data/broker.ts";
import { ClientError } from "../data/errors.ts";
import { registerReset } from "./store-registry";

/** Raw representations and digest survive independently of parsed display content. */
export type EventDocument = Readonly<{
  name: string;
  contentJson: string | null;
  orderedJson: string | null;
  contentDigest: string | null;
  content: unknown;
}>;

/** The per-event load state. Absent entry = never opened (never read). */
export type EventDocumentsLoad = Readonly<
  | { kind: "pending" }
  | { kind: "measured"; documents: readonly EventDocument[] }
  | { kind: "absent"; reason: string }
  | { kind: "failed"; reason: string }
>;

/**
 * The documents reader, injectable for tests. Returns the route's own
 * document rows for one event id; a 404 is reported as `null` (the door's
 * deny-by-default absence), anything else as the parsed record.
 */
export type EventDocumentsReader = (
  eventId: string,
) => Promise<readonly EventDocument[] | null>;

// Preserve the route's raw document fields even when display parsing succeeds.
const liveReader: EventDocumentsReader = async (eventId) => {
  try {
    const event = await fetchJson<{
      documents?: readonly { name?: unknown; contentJson?: unknown; orderedJson?: unknown; contentDigest?: unknown }[];
      error?: unknown;
    }>(`/timeline/events/${encodeURIComponent(eventId)}`);
    if (event === null || typeof event !== "object" || event.error !== undefined) {
      // The door's own absence: not the caller's event, or gone. `null`
      // carries it — an absent record is not a failure of the fold.
      return null;
    }
    const rows = Array.isArray(event.documents) ? event.documents : [];
    return rows
      .map((row): EventDocument | null => {
        if (typeof row?.name !== "string") return null;
        const contentJson = typeof row.contentJson === "string" ? row.contentJson : null;
        const orderedJson = typeof row.orderedJson === "string" ? row.orderedJson : null;
        const contentDigest = typeof row.contentDigest === "string" ? row.contentDigest : null;
        const raw = contentJson ?? orderedJson;
        let content: unknown = null;
        if (raw !== null) {
          try {
            content = JSON.parse(raw);
          } catch {
            // The record's own content did not parse: keep the document
            // (its name is true) and state the unparseable content as the
            // RAW STRING it was stored as — never a fabricated value and
            // never a silently dropped document.
            content = raw;
          }
        }
        return { name: row.name, contentJson, orderedJson, contentDigest, content };
      })
      .filter((d): d is EventDocument => d !== null);
  } catch {
    // A transport failure IS a failure of the fold's read — stated as one
    // (the retry is reopening the fold), never mistaken for absence. The
    // typed carrier the data layer owns; the code names the seam.
    throw new ClientError("network", "the event's documents could not be read");
  }
};

let reader: EventDocumentsReader = liveReader;

/** Test seam. Returns the previous reader so a test can restore it. */
export function setEventDocumentsReader(next: EventDocumentsReader): EventDocumentsReader {
  const prev = reader;
  reader = next;
  return prev;
}

// ── Store ──

const EMPTY_LOADS = new Map<string, EventDocumentsLoad>();

/**
 * Per-event fold state, keyed by the canonical eventId. A key present with
 * no entry means the fold was never opened — the store's honest "not read".
 */
export const eventDocumentsLoads = atom<ReadonlyMap<string, EventDocumentsLoad>>(EMPTY_LOADS);

/**
 * Read (once) the documents of one event — called when a fold is OPENED
 * (the lazy read: an unopened fold costs nothing and invents nothing).
 * Idempotent per event: a measured/absent/failed load stands until the
 * registry reset; reopening the fold after a failure is the honest retry.
 */
export async function loadEventDocuments(eventId: string): Promise<void> {
  const loads = eventDocumentsLoads.get();
  const standing = loads.get(eventId);
  if (standing !== undefined && standing.kind !== "failed") return;
  const next = new Map(loads);
  next.set(eventId, { kind: "pending" });
  eventDocumentsLoads.set(next);
  try {
    const documents = await reader(eventId);
    const settled: EventDocumentsLoad =
      documents === null
        ? { kind: "absent", reason: "this event's record is not reachable" }
        : documents.length === 0
          ? { kind: "measured", documents: [] }
          : { kind: "measured", documents };
    // Settle ONLY onto this load's own pending entry. A reset (or another
    // load for the same event) removed/replaced the entry mid-flight — a
    // late answer for a fold whose state was cleared must resurrect
    // nothing: the store's truth is what its current writer last said.
    const current = eventDocumentsLoads.get();
    if (current.get(eventId)?.kind === "pending") {
      const settledMap = new Map(current);
      settledMap.set(eventId, settled);
      eventDocumentsLoads.set(settledMap);
    }
  } catch (err) {
    const current = eventDocumentsLoads.get();
    if (current.get(eventId)?.kind === "pending") {
      const failedMap = new Map(current);
      failedMap.set(eventId, {
        kind: "failed",
        reason: err instanceof Error ? err.message : "the event's documents could not be read",
      });
      eventDocumentsLoads.set(failedMap);
    }
  }
}

export function resetEventDocuments(): void {
  eventDocumentsLoads.set(EMPTY_LOADS);
}

registerReset("timeline-event-documents", resetEventDocuments);
