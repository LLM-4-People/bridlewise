/**
 * WHICH WORKSPACE A LIVE RUN BELONGS TO — and what happens to its stream when
 * you look at a different tab.
 *
 * The transcript and live band describe the active chat. The client guards
 * every stream callback against that foreground owner. This registry owns
 * transport lifetime: background workspaces park their source and reopen
 * from the existing server replay when selected again. Model-output gaps
 * and epilogues retain ownership until the transport actually ends.
 *
 * Superseded attachments and permanently closed workspaces retire their
 * local source. Neither operation stops the run executing on the server.
 *
 * @see src/cockpit/flow/run-stream.ts — the send path that registers here
 * @see src/cockpit/flow/ingest.ts — the freeze this registry drives
 */

import { protectLog, unprotectLog } from "./log.ts";

/** A run, and the workspace it belongs to. */
export type LiveRun = Readonly<{
  runId: string;
  workspaceId: string;
  chatId: string;
}>;

type Entry = {
  readonly runId: string;
  readonly workspaceId: string;
  readonly chatId: string;
  /** Close the open stream. Null once parked. */
  controller: { close: () => void } | null;
  /** Re-open the stream for this run. */
  readonly reopen: () => { close: () => void };
  parked: boolean;
};

const entries = new Map<string, Entry>();

/**
 * The workspace considered active. Held here rather than read from
 * `state/workspaces.ts` so this registry stays a plain, Node-testable module;
 * `run-stream.ts` subscribes the atom and pushes the value in.
 */
let activeId: string | null = null;

/**
 * A run has started and its stream is open. `reopen` is supplied by the
 * caller (it owns the handlers) so this module never imports the client.
 */
export function noteRunStarted(
  run: LiveRun,
  controller: { close: () => void },
  reopen: () => { close: () => void },
): void {
  const previous = entries.get(run.runId);
  if (previous?.controller !== controller) previous?.controller?.close();
  entries.set(run.runId, {
    runId: run.runId,
    workspaceId: run.workspaceId,
    chatId: run.chatId,
    controller,
    reopen,
    parked: false,
  });
  // A log being written by a live run is never an eviction candidate: the
  // budget must not drop the beats of the one conversation still moving.
  protectLog(run.workspaceId);
  // A start may resolve after its workspace was left. Park that transport
  // immediately using the same switch owner, never bind it to the new tab.
  applyActiveWorkspace(activeId);
}

/** The transport actually ended; model-output boundaries retain ownership. */
export function noteRunEnded(runId: string): void {
  const entry = entries.get(runId);
  if (entry === undefined) return;
  entries.delete(runId);
  if (![...entries.values()].some((e) => e.workspaceId === entry.workspaceId)) {
    unprotectLog(entry.workspaceId);
  }
}

/** Forget a permanently removed workspace's local attachments, without cancelling its server runs. */
export function forgetWorkspaceRuns(workspaceId: string): void {
  for (const entry of entries.values()) {
    if (entry.workspaceId !== workspaceId) continue;
    entry.controller?.close();
    noteRunEnded(entry.runId);
  }
}

/** Every run currently registered, parked or not. */
export function liveRuns(): readonly LiveRun[] {
  return [...entries.values()].map((e) =>
    Object.freeze({ runId: e.runId, workspaceId: e.workspaceId, chatId: e.chatId }),
  );
}

/**
 * The one live run, when there is exactly one.
 *
 * `null` for none and for several. The ingest freeze uses a sole owner when
 * available; the client's foreground guard still scopes every callback when
 * multiple registered runs make this optional hint ambiguous.
 */
export function soleLiveRun(): LiveRun | null {
  if (entries.size !== 1) return null;
  const e = [...entries.values()][0]!;
  return Object.freeze({ runId: e.runId, workspaceId: e.workspaceId, chatId: e.chatId });
}

/** Does this workspace have a run in flight (parked or streaming)? */
export function hasLiveRun(workspaceId: string): boolean {
  return [...entries.values()].some((e) => e.workspaceId === workspaceId);
}

/** Is this workspace's run parked — streaming on the server, not here? */
export function isParked(workspaceId: string): boolean {
  return [...entries.values()].some((e) => e.workspaceId === workspaceId && e.parked);
}

/**
 * The active workspace changed: park every stream that no longer owns the
 * screen, and re-open every parked stream that just got it back.
 *
 * Idempotent — called with the same id twice does nothing the second time,
 * so a store that re-notifies cannot double-close or double-open.
 */
export function applyActiveWorkspace(id: string | null): void {
  activeId = id;
  for (const entry of entries.values()) {
    const mine = entry.workspaceId === id;
    if (!mine && !entry.parked) {
      entry.controller?.close();
      entry.controller = null;
      entry.parked = true;
    } else if (mine && entry.parked) {
      const controller = entry.reopen();
      entry.controller = controller;
      entry.parked = false;
    }
  }
}

/** The workspace this registry believes is active. */
export function activeWorkspaceForRuns(): string | null {
  return activeId;
}

/** Forget everything (sign-out / tests). Closes any open stream. */
export function resetRunOwnership(): void {
  for (const entry of entries.values()) {
    entry.controller?.close();
    unprotectLog(entry.workspaceId);
  }
  entries.clear();
  activeId = null;
}
