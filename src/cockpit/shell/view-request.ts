/**
 * A SHELL VIEW, ASKED FOR FROM OUTSIDE THE SHELL — the seam the LLM's
 * `control_interface` pipeline lands on.
 *
 * Every in-shell navigation goes through the `ShellApi` handle a mounted
 * surface receives as a prop, and that stays true: this module is NOT a
 * second navigation path for components. It exists for exactly the callers
 * that have no shell handle because they are not components at all — the
 * `ui_control` SSE listener (src/client.ts → src/state/ui-control.ts) runs
 * in plain module code, and threading a component prop out to it would mean
 * the shell handing its API to the network layer.
 *
 * Same one-shot contract as the settings index's pending query
 * (settings-feed.ts::pendingIndexQuery): the request is an atom, the shell
 * consumes it, and consuming clears it — a request that outlived the shell
 * that should have honored it must not fire on the NEXT mount, which would
 * be a navigation nobody just asked for.
 *
 * The shell stays the only authority on what opening means: it applies its
 * own `roomExists` check and its own open path (keep-alive revisit, warm
 * plan, activation record), so a request through this seam and a ⌘G through
 * the chord table land in the identical place.
 */

import { atom, type ReadableAtom } from "nanostores";

import type { RoomId } from "./contract.ts";
import type { InspectorGroupId, InspectorSectionId } from "../../../shared/routes.ts";

/** What is being asked for: one of the shell's rooms, or the flow itself
 * (no room on screen — the conversation).
 *
 * `path` is the OPTIONAL PAYLOAD a room request may carry: a file
 * the room should land on. Today exactly one room can consume it — the
 * editor — and the shell forwards it through the editor's own one-shot open
 * seam (src/cockpit/editor/open-request.ts) before opening the room, so the
 * request lands through the identical open mechanism a tree click uses. A
 * payload on a room that cannot consume it is REFUSED with the honest hint,
 * never silently dropped — deny-by-default, so a future room gains payload
 * support by being wired, not by accident. */
export type ShellViewRequest =
  | Readonly<{ kind: "room"; id: RoomId; path?: string }>
  | Readonly<{ kind: "flow" }>
  /**
   * The conversation's right-side inspector (the run pane). Not a room —
   * it docks beside the flow rather than covering it — so it gets its own
   * kind rather than a false room id the shell would have to special-case.
   */
  | Readonly<{ kind: "pane"; mode?: "open" | "close" | "toggle"; group?: InspectorGroupId; section?: InspectorSectionId }>;

const pending = atom<ShellViewRequest | null>(null);

/** Readable for the shell's subscription (and for tests to observe). */
export const pendingShellView: ReadableAtom<ShellViewRequest | null> = pending;

/** Ask the shell to show a view. Overwrites an unconsumed earlier request —
 * the newest instruction is the one the operator's agent just gave. */
export function requestShellView(view: ShellViewRequest): void {
  pending.set(view);
}

/** Read-and-clear, called by the shell when it acts (or by a teardown). */
export function consumeShellViewRequest(): ShellViewRequest | null {
  const current = pending.get();
  pending.set(null);
  return current;
}
