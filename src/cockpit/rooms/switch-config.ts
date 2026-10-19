/**
 * @config-owner — THE SWITCH (spec §5.2 values + time-unit anchors).
 *
 * The single owner of the Switch room's tunable constants, following the
 * cockpit pattern (computer-config.ts, shell/config.ts): numbers live
 * here, behavior lives in the modules that import them.
 */

/** One minute/hour/day in milliseconds — the relative-time ladder's units. */
export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** Days before a reel's relative time becomes a calendar date. */
export const RELATIVE_DATE_CUTOFF_DAYS = 14;

/** Broker TTL for the per-reel pulse/spectrum reads. The Broker's own
 * `run:done` invalidation refreshes sooner when a run actually ends. */
export const SWITCH_READ_TTL_MS = 60_000;

/**
 * THE CAP IS A SHARE OF THE BROWSER'S POOL, NOT A NUMBER WE PICK FREELY.
 *
 * This was 6 — exactly the per-host connection limit browsers allow on
 * HTTP/1.1. So the Switch alone could hold every socket this origin gets, and
 * everything else queued behind it: history reads climbed to 23s, dozens of
 * requests were aborted by the browser (`NS_BINDING_ABORTED`), and
 * `/api/live` — the standing stream whose whole job is noticing outages —
 * waited **36 seconds** for a socket and reported a false outage against a
 * server answering in 2ms.
 *
 * The budget is ~6 per host. One is permanently spent on the liveness stream.
 * Taking 2 leaves 3 for the things a reader is actually waiting on — the open
 * conversation's history, the desk, a run stream. A background list filling in
 * badges must never outrank the thing on screen.
 *
 * Lives HERE, in the leaf config module (same reason as
 * {@link MICRO_SWEEP_BINS}): the perf profile's 10k-projects phase asserts
 * the boot chats fan-out never exceeds this bound, and the profile runs in
 * Node (Playwright), which must not import the feed's store graph to read
 * one number. `switch-feed.ts` re-exports it, so no call site moved.
 */
export const FEED_CONCURRENCY = 2;

/** Pixel window extends on both sides for continuous scrolling. */
export const SWITCH_OVERSCAN_PX = 300;
/** Before the viewport is measurable (SSR/tests), still reveal real rows. */
export const SWITCH_VIEWPORT_ESTIMATE = 600;
/** Most project groups placed side by side on a wide river; narrower widths
 * use fewer (the measured reel tracks), compact widths stack one. */
export const SWITCH_MAX_PROJECT_COLUMNS = 3;

/** Bins for a reel's density strip. The strip spans the row; 64 bars
 * stay one identity for the spectrum read (warm-on-intent agrees).
 *
 * Lives HERE, in the leaf config module, rather than in switch-feed.ts,
 * because it is part of the read's IDENTITY: `sweep.spectrum?bins=64&…` is a
 * different cache entry from `bins=32`, so anything that names that read —
 * the feed, and the shell's warm-on-intent plan (shell/room-warm.ts) — has to
 * agree on the number. The shell cannot import the feed (loading a room's
 * feed at boot is exactly what warming exists to avoid), so the constant sits
 * where both can reach it. `switch-feed.ts` re-exports it, so no call site
 * moved. */
export const MICRO_SWEEP_BINS = 64;

/** Second-press window for recycling a project or conversation (ms). */
export const RECYCLE_CONFIRM_WINDOW_MS = 10_000;

/**
 * Freshly armed recycle REFUSES to execute (ms). The same button is arm
 * and confirm, so a dblclick would otherwise fire both in one gesture.
 */
export const RECYCLE_CONFIRM_SETTLE_MS = 400;
