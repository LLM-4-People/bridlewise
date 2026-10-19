/**
 * WHAT IS ON SCREEN — the shell's one answer, and the seam a feed uses to go
 * quiet without going blank.
 *
 * THE PROBLEM THIS SOLVES. Rooms used to mount on open and UNMOUNT on close,
 * so every reopen was a cold start: the component tree rebuilt, scroll snapped
 * to the top, expansion state vanished, and the feed re-acquired from nothing.
 * The fix is keep-alive (RoomHost keeps every VISITED room mounted and hides
 * the inactive ones with `visibility`), but keep-alive creates a second
 * problem immediately: a hidden room's feed would keep polling forever, and
 * "nothing polls for nobody" is a cost law this project actually keeps.
 *
 * So a kept-alive room needs to know when it is the thing being looked at.
 * That is ALL this module publishes. The rule it enforces is:
 *
 *     QUIET WHEN HIDDEN, WARM WHEN SHOWN — and NEVER blank in between.
 *
 * The distinction matters and it is the whole point. Going quiet means
 * stopping ACQUISITION (the timer, the subscription, the poll). It does NOT
 * mean clearing what was measured: the last values stand, with their own
 * `asOf`, so the reopen paints them in frame one and the revalidation lands
 * underneath. A feed that cleared its stores on hide would re-create exactly
 * the cold start keep-alive was built to remove.
 *
 * ADOPTION IS ONE LINE per surface, in `onMount`:
 *
 *     onMount(() => whileRoomVisible("instruments", acquireInstrumentsFeed));
 *
 * `whileRoomVisible` returns the unsubscribe, so returning it from `onMount`
 * is the whole lifecycle: held while shown, released while hidden, released
 * for good when the room is finally torn down (sign-out, HMR).
 *
 * WHY A STORE AND NOT A PROP. Rooms receive exactly `OutletProps` ({ shell })
 * — the file-convention contract in contract.ts that lets a sibling agent
 * mount a surface without any shell file being edited. Threading a `hidden`
 * prop through would change that contract for every surface, present and
 * future. A store is read by the surfaces that care and ignored by the ones
 * that do not.
 *
 * @see src/cockpit/shell/RoomHost.svelte — the keep-alive host that writes it
 * @see src/cockpit/shell/room-warm.ts — the other half: warming on intent
 */

import { atom, type ReadableAtom } from "nanostores";

import type { RoomId } from "./contract.ts";

/**
 * The room currently ON SCREEN, or null when the flow is (no room open).
 *
 * Written ONLY by the shell (`setVisibleRoom`, called from Cockpit.svelte).
 * A second writer would be a second opinion about what the user is looking
 * at, and the day they disagreed a hidden room would poll while a visible one
 * sat frozen.
 */
export const visibleRoom: ReadableAtom<RoomId | null> = atom<RoomId | null>(null);
const visibleRoomW = visibleRoom as ReturnType<typeof atom<RoomId | null>>;

/**
 * Whether a SHELL is currently mounted and therefore able to say what is on
 * screen. With no shell there is nothing this module can truthfully report —
 * see `holdWhile` for what that means for a surface.
 */
let published = false;

/**
 * SHELL ONLY, from `onMount`. Declares "a cockpit exists and it will tell you
 * what is on screen"; returns the teardown.
 *
 * Bound to the shell's LIFETIME rather than set once at module load, because
 * the alternative — a flag that latches true forever — outlives the shell that
 * set it. A torn-down cockpit would leave every later surface believing a
 * silent authority was still watching, and they would sit hidden-and-quiet
 * with nothing left to un-hide them.
 */
export function bindShellVisibility(): () => void {
  published = true;
  visibleRoomW.set(null); // a fresh shell has no room open
  return () => {
    published = false;
    visibleRoomW.set(null);
  };
}

/**
 * SHELL ONLY. Publish which room is on screen.
 *
 * Idempotent: writing the value it already holds notifies nobody, so a
 * re-render of the shell cannot make a feed release and re-acquire (which
 * would cost a poll and, worse, look like a reload).
 */
export function setVisibleRoom(id: RoomId | null): void {
  if (visibleRoomW.get() === id) return;
  visibleRoomW.set(id);
}

/**
 * Hold `acquire` open only while `roomId` is the room on screen.
 *
 * `acquire` is the feed's own ref-counted hold and returns its release — the
 * shape every cockpit feed already exposes (`acquireInstrumentsFeed`,
 * `startSpectrumFeed`), so adoption never means rewriting a feed.
 *
 * Returns the unsubscribe, which also releases a currently-held acquisition:
 * a room torn down while visible must not leave a poll running behind it.
 */
export function whileRoomVisible(
  roomId: RoomId,
  acquire: () => () => void,
): () => void {
  return holdWhile((visible) => visible === roomId, acquire);
}

/**
 * The mirror for the FLOW and the fixed instruments around it: held whenever
 * NO room covers the screen.
 *
 * A full-screen room hides the flow completely, so work the flow does to keep
 * its pixels current is work nobody can see. Same law as above: stop the
 * acquisition, keep the measured state — the flow's scroll position and its
 * rendered beats are exactly what must survive the excursion.
 */
export function whileFlowVisible(acquire: () => () => void): () => void {
  return holdWhile((visible) => visible === null, acquire);
}

/**
 * The shared body: subscribe, hold while the predicate holds, release when it
 * stops — and never double-acquire (nanostores fires the current value on
 * subscribe, and a re-fire of the same value must be a no-op).
 *
 * WHEN NO SHELL HAS PUBLISHED, a mounted surface counts as visible. That is
 * not a loophole, it is the honest default: this module reports what the shell
 * put on screen, and with no shell there is nothing it can truthfully say, so
 * the fact that something mounted the surface is the only evidence available.
 * It keeps a room testable in isolation and keeps the failure direction safe —
 * a shell that forgot to publish would merely lose the savings, never freeze a
 * visible surface.
 */
function holdWhile(
  wants: (visible: RoomId | null) => boolean,
  acquire: () => () => void,
): () => void {
  let release: (() => void) | null = null;
  const stop = visibleRoom.subscribe((visible) => {
    const want = !published || wants(visible);
    if (want && release === null) release = acquire();
    else if (!want && release !== null) {
      release();
      release = null;
    }
  });
  return () => {
    stop();
    if (release !== null) {
      release();
      release = null;
    }
  };
}
