/**
 * WHAT A RUN SAID, AND WHO IS LISTENING — the run feed.
 *
 * A run publishes frames here. Subscribers read them. The run does not know
 * how many subscribers there are, or whether there are any at all, and that
 * separation is the whole fix.
 *
 * ── WHAT IT REPLACES ───────────────────────────────────────────────────────
 *
 * The run used to write directly into ONE HTTP response, which made the run's
 * lifetime the response's lifetime. Three consequences, all measured:
 *
 *   - a second connection to the same run started a SECOND execution — two
 *     POSTs to the provider of 38,429 bytes each, byte-identical, billed
 *     twice, and the same tool call executed twice;
 *   - either connection closing aborted the shared run, so one party's
 *     disconnect ended another party's paid work;
 *   - a dropped connection made the run unreachable for good — the reconnect
 *     got a 404, not the rest of the stream.
 *
 * With a feed in between, a subscriber is a reader of a record. Arriving late
 * replays; leaving unsubscribes; coming back replays again. None of it
 * reaches the run.
 *
 * ── SEQUENCE NUMBERS ARE THE PRODUCT, NOT AN IMPLEMENTATION DETAIL ─────────
 *
 * Every frame carries a sequence, counting from 1. That number is written to
 * the wire as SSE's own `id:` field, and a reconnecting browser sends it back
 * as `Last-Event-ID`. Before this, the server wrote `retry:` — telling the
 * browser to reconnect — while emitting no `id:` at all and never reading the
 * header, so a client that did reconnect had no way to say where it had got
 * to. Telling a client to come back to a stream it cannot resume, on a server
 * that deleted the run when it left, was three mechanisms pointing in three
 * directions.
 *
 * ── THE BUFFER IS BOUNDED, AND SAYS SO WHEN IT DROPS ───────────────────────
 *
 * Memory is finite, so a feed holds at most `runFeedMaxFrames` and drops the
 * oldest beyond that. It records the highest sequence it can no longer serve
 * as `droppedBefore`, and a subscriber asking for something older is TOLD the
 * frames are gone rather than silently handed a stream that skips. An
 * unreported gap is a fabricated continuity, which is the same defect as an
 * invented number.
 *
 * ── AND THE SAME RULE AT THE OTHER END OF THE NUMBER LINE ──────────────────
 *
 * `droppedBefore` only ever fired BELOW. A subscriber resuming from a
 * sequence this run had never reached got `200`, zero frames and no report at
 * all — indistinguishable from "you are up to date" while actually meaning
 * "your position is one this run could not have produced". That is the same
 * fabricated continuity arriving through the other door, so it is reported
 * too (`resumeAhead`).
 *
 * ── A FEED CANNOT END WITHOUT SAYING THE RUN ENDED ─────────────────────────
 *
 * Ending a feed closes every subscriber's socket, and a browser reads a
 * server-closed EventSource as an instruction to RECONNECT. So a feed that
 * ends without a terminal frame does not merely fail to inform the client —
 * it starts a loop: reconnect, replay, re-ingest, disconnect, wait, repeat,
 * for the whole retention window. Measured on the cancel path: the run's
 * `model` `start` was replayed on every fresh reconnect and each one appended
 * another empty assistant bubble.
 *
 * The fix is not another publish call on the cancel path — that is a list,
 * and the next exit path added would not be on it. `endRunFeed` DEMANDS a
 * terminal frame (the type refuses a non-terminal one) and publishes it
 * itself if the run has not already published one. Ending a feed silently is
 * therefore not a thing that can be written.
 */

import { serverConfig } from "../kernel/config.ts";
import { guarded } from "../kernel/canonical.ts";
import {
  type SseEventType,
  type TerminalSseEventType,
  isTerminalSseEventType,
} from "../../shared/constants.ts";
import { webWarn } from "../observability/debug-bridge.ts";
import { registerComponent } from "../observability/component-registry.ts";

/** One published frame. `sequence` is the SSE `id:` a client resumes from. */
export type RunFrame = Readonly<{
  readonly sequence: number;
  readonly event: SseEventType;
  readonly data: unknown;
}>;

/** What a subscriber is handed when it attaches. */
export type RunReplay = Readonly<{
  /** The frames it asked for that the feed still holds, in order. */
  readonly frames: readonly RunFrame[];
  /**
   * The highest sequence the feed can no longer serve, or 0 when nothing has
   * been dropped. A subscriber whose `fromSequence` is below this missed
   * frames, and is told so instead of being given a stream with a hole in it.
   */
  readonly droppedBefore: number;
  /** Whether the run has already reached a terminal state. */
  readonly ended: boolean;
  /**
   * The highest sequence this run has ever published, or 0 before its first
   * frame. Reported rather than inferred: a subscriber cannot tell "nothing
   * new" from "nothing you asked for exists" without it.
   */
  readonly highestSequence: number;
  /**
   * The subscriber asked to resume from PAST everything this run has
   * published — a position this feed could not have minted.
   *
   * `droppedBefore` is the same statement in the other direction, and only
   * that direction was ever reported: a resume point above the feed's own
   * position produced an empty replay and silence, which reads as "you are up
   * to date". It is not, and on a live run it is a silent skip of every frame
   * between the run's real position and the impossible one.
   */
  readonly resumeAhead: boolean;
}>;

type Feed = {
  /** Who the run belongs to. The subscriber route's 403 reads this, so a run
   *  stays ownership-checkable after the registry has forgotten it — which is
   *  what lets a reconnect work at all. */
  readonly userId: string;
  readonly chatId: string | null;
  frames: RunFrame[];
  nextSequence: number;
  droppedBefore: number;
  ended: boolean;
  /** Whether a frame meaning "this run has stopped producing" has already
   *  been published. `endRunFeed` publishes one when it has not, which is
   *  what makes ending silently impossible rather than merely discouraged. */
  terminalPublished: boolean;
  /** Live subscribers. A Set, so unsubscribing is exact and a subscriber that
   *  attaches twice is two readers rather than one silently replaced. */
  readonly onFrame: Set<(frame: RunFrame) => void>;
  readonly onEnd: Set<() => void>;
  /** The release timer for a finished feed. Unref'd — a retained feed must
   * never be the reason a process refuses to exit. */
  releaseTimer: ReturnType<typeof setTimeout> | null;
  /** The component-registry unregister for this feed — set by openRunFeed,
   * called by the SAME releaseRunFeed that drops the feed, so an open feed
   * cannot exist unregistered and a registry entry cannot outlive it. */
  unregisterComponent: () => void;
};

const feeds = new Map<string, Feed>();

/**
 * Begin a feed for a run. Called once, by the start route, BEFORE the
 * executor publishes anything — so a subscriber that arrives in the window
 * between "started" and "first frame" attaches to a real feed rather than
 * meeting a 404 and concluding the run does not exist.
 */
export function openRunFeed(
  runId: string,
  owner: Readonly<{ readonly userId: string; readonly chatId: string | null }>,
): void {
  const existing = feeds.get(runId);
  if (existing !== undefined) {
    // A run id is minted per start and a feed is opened once. Reaching here
    // means two starts claimed one id, which the run-execution claim refuses
    // at the database — so this is reported, never quietly merged into the
    // existing feed where two runs' frames would interleave under one id.
    webWarn("run-feed", "feed already open for run", () => ({ runId }));
    return;
  }
  // ANATOMY REGISTRATION — at the owner, on the open path: every open feed
  // is a registry component for exactly its lifetime (removed by the
  // releaseRunFeed below — the retention timer and releaseAllRunFeeds both
  // go through it, so a closed feed always leaves the registry).
  const unregisterComponent = registerComponent({
    kind: "run-feed",
    label: runId,
    provenance: "server/run/run-feed.ts openRunFeed",
    facts: { userId: owner.userId, chatId: owner.chatId },
  });
  feeds.set(runId, {
    userId: owner.userId,
    chatId: owner.chatId,
    frames: [],
    nextSequence: 1,
    droppedBefore: 0,
    ended: false,
    terminalPublished: false,
    onFrame: new Set(),
    onEnd: new Set(),
    releaseTimer: null,
    unregisterComponent,
  });
}

/**
 * Append a frame and hand it to every live subscriber. Returns the sequence
 * assigned, or 0 when there is no feed for this run.
 *
 * A subscriber that throws does not stop the others and does not stop the
 * run: one reader's failure is that reader's problem, and a run that dies
 * because a socket misbehaved is the coupling this module exists to remove.
 */
export function publishRunFrame(runId: string, event: SseEventType, data: unknown): number {
  const feed = feeds.get(runId);
  if (feed === undefined) return 0;
  // NOTHING FOLLOWS THE ENDING, and this is where that is true rather than
  // where it is remembered.
  //
  // A terminal frame's own contract is that the client closes on it, so a
  // frame published afterwards reaches nobody live — it is computed, sent,
  // and delivered to an audience that was told to leave. It happened: `done`
  // was published BEFORE the run's timeline and agent frames, so every one of
  // those was written to closed sockets and survived only as replay padding,
  // which then evicted the `done` itself out of a bounded buffer. Refused
  // here, loudly, so the ordering cannot silently rot back.
  if (feed.terminalPublished) {
    webWarn("run-feed", "frame published after the run already ended", () => ({
      runId,
      event,
    }));
    return 0;
  }
  const frame: RunFrame = Object.freeze({ sequence: feed.nextSequence, event, data });
  feed.nextSequence += 1;
  feed.frames.push(frame);
  // Recorded HERE rather than at the executor's call sites, because the
  // question `endRunFeed` has to answer is "did this run already say it was
  // over?" — a fact about the record, not about which branch produced it. A
  // flag set by the caller would be a second thing to keep in step.
  if (isTerminalSseEventType(event)) feed.terminalPublished = true;
  const max = serverConfig.runFeedMaxFrames;
  if (feed.frames.length > max) {
    const dropped = feed.frames.splice(0, feed.frames.length - max);
    const last = dropped[dropped.length - 1];
    if (last !== undefined) feed.droppedBefore = last.sequence;
  }
  for (const listener of feed.onFrame) {
    try {
      listener(frame);
    } catch (err) {
      webWarn("run-feed", "subscriber threw while receiving a frame", () => ({
        runId,
        sequence: frame.sequence,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }
  return frame.sequence;
}

/**
 * WHAT A CALLER MUST BE ABLE TO SAY TO END A FEED.
 *
 * The frame published when — and only when — the run has not already said it
 * is over. Its type is the union of the terminal frames, so ending a feed
 * with something that does not mean "this run has stopped producing" is not
 * expressible.
 */
export type RunTerminalFrame = Readonly<{
  readonly event: TerminalSseEventType;
  readonly data: unknown;
}>;

/**
 * Mark the run terminal and tell every subscriber. The feed is RETAINED for
 * `runFeedRetentionMs` so a client whose socket dropped as the run ended can
 * still reconnect, replay the tail, and see the terminal frame.
 *
 * THE TERMINAL FRAME IS A REQUIRED ARGUMENT, and that is the whole of the
 * fix. Ending a feed closes every subscriber's socket, which a browser reads
 * as "reconnect" — so a feed that ends without a terminal frame does not lose
 * one message, it loops: reconnect, replay, re-ingest, close, wait, repeat,
 * for the entire retention window. The old shape let a caller end a feed
 * silently by writing nothing at all, and the cancel path did exactly that.
 * Now the argument cannot be omitted (a compile error) and cannot be a
 * non-terminal frame (a type error), and if the run already published one
 * this is not published at all — so a normal completion still ends with
 * exactly one `done`.
 */
export function endRunFeed(runId: string, terminal: RunTerminalFrame): void {
  const feed = feeds.get(runId);
  if (feed === undefined || feed.ended) return;
  // Published BEFORE `ended` is set and before the end listeners run: the
  // listeners close sockets, and a frame written after that reaches nobody
  // live and — worse — would be appended to the retained buffer AFTER the
  // subscribers were told there was nothing more, which is the reconnect
  // loop's own shape in miniature.
  if (!feed.terminalPublished) publishRunFrame(runId, terminal.event, terminal.data);
  feed.ended = true;
  for (const listener of [...feed.onEnd]) {
    try {
      listener();
    } catch (err) {
      webWarn("run-feed", "subscriber threw while being told the run ended", () => ({
        runId,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }
  // The window is FLOORED by the config resolver at more than one reconnect
  // interval, so there is no configuration in which a finished run's feed is
  // gone before the client that was watching it can come back — see
  // `DEFAULT_RUN_FEED_RETENTION_MS`. There is no zero case to branch on.
  const retentionMs = serverConfig.runFeedRetentionMs;
  feed.releaseTimer = setTimeout(guarded("run-feed.release", () => releaseRunFeed(runId)), retentionMs);
  feed.releaseTimer.unref?.();
}

/** Drop a finished feed's memory. Idempotent. */
export function releaseRunFeed(runId: string): void {
  const feed = feeds.get(runId);
  if (feed === undefined) return;
  if (feed.releaseTimer !== null) clearTimeout(feed.releaseTimer);
  feed.onFrame.clear();
  feed.onEnd.clear();
  feed.unregisterComponent();
  feeds.delete(runId);
}

/**
 * Attach to a run's feed from a given sequence.
 *
 * Replay happens BEFORE the subscription is registered and in the same
 * synchronous turn, so a frame published while attaching cannot slip between
 * the two and be lost. Returns the replay plus the function that detaches —
 * and detaching is ALL that leaving does. It does not abort, does not delete,
 * and the run does not find out.
 */
export function subscribeToRunFeed(
  runId: string,
  fromSequence: number,
  onFrame: (frame: RunFrame) => void,
  onEnd: () => void,
): Readonly<{ replay: RunReplay; unsubscribe: () => void }> | undefined {
  const feed = feeds.get(runId);
  if (feed === undefined) return undefined;
  const after = Number.isFinite(fromSequence) && fromSequence > 0 ? Math.floor(fromSequence) : 0;
  // The highest sequence this run has actually published. `nextSequence` is
  // the one it will assign NEXT, so the last one it assigned is one below —
  // and 0 before the first frame, which is the honest answer for a feed that
  // has published nothing rather than a negative number nobody can read.
  const highestSequence = feed.nextSequence - 1;
  const replay: RunReplay = Object.freeze({
    frames: Object.freeze(feed.frames.filter((f) => f.sequence > after)),
    droppedBefore: after < feed.droppedBefore ? feed.droppedBefore : 0,
    ended: feed.ended,
    highestSequence,
    resumeAhead: after > highestSequence,
  });
  feed.onFrame.add(onFrame);
  feed.onEnd.add(onEnd);
  return Object.freeze({
    replay,
    unsubscribe: () => {
      feed.onFrame.delete(onFrame);
      feed.onEnd.delete(onEnd);
    },
  });
}

/**
 * Who a run belongs to, for as long as its feed is retained.
 *
 * The subscriber route's ownership gate reads this when the registry has
 * already forgotten a finished run, which is how the 403 survives past the
 * run's end without the 404 swallowing a legitimate reconnect first.
 */
export function runFeedOwner(
  runId: string,
): Readonly<{ readonly userId: string; readonly chatId: string | null }> | undefined {
  const feed = feeds.get(runId);
  if (feed === undefined) return undefined;
  return Object.freeze({ userId: feed.userId, chatId: feed.chatId });
}

/**
 * The feed's state as numbers, for diagnostics and for guards.
 *
 * A guard that bounds a population has to be able to STATE that population at
 * runtime rather than assert a floor on something it never measured, so the
 * counts are reportable rather than inferable.
 */
export function runFeedState(
  runId: string,
): Readonly<{
  readonly frames: number;
  readonly nextSequence: number;
  readonly droppedBefore: number;
  readonly ended: boolean;
  readonly subscribers: number;
  /** Whether this run has published a frame meaning it has stopped
   *  producing. A guard about the reconnect loop has to be able to ask this
   *  without re-deriving it from the frame list. */
  readonly terminalPublished: boolean;
}> | undefined {
  const feed = feeds.get(runId);
  if (feed === undefined) return undefined;
  return Object.freeze({
    frames: feed.frames.length,
    nextSequence: feed.nextSequence,
    droppedBefore: feed.droppedBefore,
    ended: feed.ended,
    subscribers: feed.onFrame.size,
    terminalPublished: feed.terminalPublished,
  });
}

/** How many feeds this process is holding. */
export function runFeedCount(): number {
  return feeds.size;
}

/** Release every feed. Used by the shutdown path and by tests that must not
 *  leak a retained feed into the next case. */
export function releaseAllRunFeeds(): number {
  const ids = [...feeds.keys()];
  for (const id of ids) releaseRunFeed(id);
  return ids.length;
}
