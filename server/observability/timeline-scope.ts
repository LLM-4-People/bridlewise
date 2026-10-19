/**
 * Web timeline read scope. Authentication and run ownership retain their
 * existing owners; this composes them once for both list and spectrum reads.
 * A trace membership witness hides unknown traces, but never grants access
 * to the trace's other rows. Every result carries a mandatory run predicate.
 */
import type { UserContext } from "../auth/user-context.ts";
import type { AsyncDbClient } from "../db/async-client.ts";
import { NotFoundError } from "../kernel/errors.ts";
import { getTimelineStore } from "./timeline-bridge.ts";

type TimelineSelection = Readonly<{
  ledgerId?: string | undefined;
  runId?: string | undefined;
  runIds?: readonly string[] | undefined;
  chatId?: string | undefined;
  projectId?: string | undefined;
  traceId?: string | undefined;
}>;

export async function resolveTimelineScope(
  db: AsyncDbClient,
  user: UserContext,
  selection: TimelineSelection,
): Promise<Readonly<{ ledgerId: string; runIds: readonly string[] }>> {
  // Preserve chat-before-project existence checks even when explicit runs
  // select the result. The DB mapping remains the authority for ownership.
  if (selection.chatId !== undefined) {
    if (await db.getChat(selection.chatId, user.userId) === null) {
      throw new NotFoundError(`Chat ${selection.chatId} not found`);
    }
  } else if (selection.projectId !== undefined) {
    if (await db.getProject(selection.projectId, user.userId) === null) {
      throw new NotFoundError(`Project ${selection.projectId} not found`);
    }
  }
  const ownedRuns = new Set(await db.allRunIdsForUser(user.userId));
  let selected: readonly string[];
  if (selection.runId !== undefined || selection.runIds !== undefined) {
    // Presence matters: [] alone denies all; a singular run still joins
    // the plural selection by union, even when that plural set is empty.
    selected = [...new Set([
      ...(selection.runId !== undefined ? [selection.runId] : []),
      ...(selection.runIds ?? []),
    ])];
  } else if (selection.chatId !== undefined) {
    selected = await db.runIdsForChat(selection.chatId, user.userId);
  } else if (selection.projectId !== undefined) {
    selected = await db.runIdsForProject(selection.projectId, user.userId);
  } else {
    selected = [...ownedRuns];
  }
  const runIds = selected.filter((runId) => ownedRuns.has(runId));
  const store = getTimelineStore();
  const ledgerId = selection.ledgerId ?? store.ledgerId;
  if (selection.traceId !== undefined && !store.traceMatchesAnyRun(selection.traceId, [...ownedRuns], ledgerId)) {
    throw new NotFoundError(`Trace ${selection.traceId} not found`);
  }
  return { ledgerId, runIds };
}
