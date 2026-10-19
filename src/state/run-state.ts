/**
 * nanostores shared state: current run + agent registry.
 *
 * This is a plain.ts module — Node-testable via Vitest without any Svelte
 * compiler or component harness. It is the single client-side owner of
 * run-level state projected from the backend.
 *
 * Boundary rule: this store is fed ONLY by client.ts (the sole writer).
 * Components read via $store auto-subscription; they never write directly.
 */

import { atom, computed, map, type ReadableAtom } from "nanostores";

import type {
  AgentState,
  AgentLifecycleState,
} from "../../shared/types";
import { RUN_STATUS_CLEAR_DELAY_MS } from "../client-config";
import { registerReset, registerContextReset } from "./store-registry";

// ── Run state ──

/**
 * The run's lifecycle as the client sees it.
 *
 * `cancelled` is neither `done` nor `error`, and the distinction is the
 * point: a person pressed stop, and reporting their own act as a completion
 * or as a failure would be a false statement about what happened. The SSE
 * `cancelled` frame settles a run this way, whatever door the cancel came
 * through (this tab's stop verb, another tab's, the server's own bound).
 */
export type RunStatus = "idle" | "starting" | "running" | "done" | "error" | "cancelled";

/**
 * Every run status's terminal disposition — the ONE vocabulary the run
 * view's settle and its retirement both read.
 *
 * TOTAL over RunStatus on purpose: a status added to the union without a
 * disposition here is a compile error, never a silently unhandled ending.
 * The SSE listeners hold no copy of this fact — each terminal door
 * (`done`, `cancelled`, `error`, the model-event error, the stop verb)
 * only REPORTS its status, and this record decides what the view's
 * lifetime does with it. The measured defect this shape exists to end: the
 * `error` frame's listener did everything else honestly and never settled
 * the view, because the settle lived in the doors that remembered it
 * rather than in the status vocabulary that owns it.
 */
const RUN_STATUS_TERMINAL = {
  idle: false,
  starting: false,
  running: false,
  done: true,
  error: true,
  cancelled: true,
} as const satisfies Readonly<Record<RunStatus, boolean>>;

function isTerminalRunStatus(status: RunStatus): boolean {
  return RUN_STATUS_TERMINAL[status];
}

export type RunView = {
  readonly runId: string;
  readonly status: RunStatus;
  readonly startedAt: number;
  readonly modelLabel: string | null;
  /** The project this run belongs to. A run is always scoped to exactly one
   * project (startRun takes a projectId); carrying it here lets the sidebar
   * project list show a per-project running/error/idle signal dot without a
   * separate lookup. Previously absent — the sidebar dot was dead (always
   * "idle") because `activeRun.projectId` was undefined. */
  readonly projectId: string;
};

export const currentRun = atom<RunView | null>(null);

export const isRunActive = computed(currentRun, (run) =>
  run !== null && (run.status === "starting" || run.status === "running"),
);

// ── The steering queue ──────────────────────────────────────────────────────
//
// How many user instructions are queued for the LIVE run's next turn. Set by
// the steer send (the server answers with the queue depth), counted down by
// the SSE `steered` frame (one per consumed instruction, with the remaining
// depth), and cleared at every run boundary — a new run starts from absence
// and the context reset (chat switch) drops it with everything else. The run
// pane's progress section reads it so the run's own inspector states that an
// instruction is waiting, in the same place it states everything else about
// the run.

/** Queued steering instructions for the live run, or 0 when none wait. */
export const queuedSteers = atom<number>(0);

export function setQueuedSteers(count: number): void {
  queuedSteers.set(Number.isFinite(count) && count > 0 ? Math.floor(count) : 0);
}

// ── Agent registry ──

export const agents = map<Readonly<Record<string, AgentState>>>({});

export const activeAgents = computed(agents, (all) =>
  Object.values(all).filter(
    (a) => a.lifecycleState === "running" || a.lifecycleState === "pending",
  ),
);

export const agentsByState = computed(agents, (all) => {
  const grouped: Record<AgentLifecycleState, AgentState[]> = {
    pending: [],
    running: [],
    succeeded: [],
    failed: [],
    cancelled: [],
    suspended: [],
    idle: [],
    "timed-out": [],
  };
  for (const a of Object.values(all)) {
    grouped[a.lifecycleState].push(a);
  }
  return grouped;
});

export const agentCount = computed(agents, (all) => Object.keys(all).length);

// ── Ingestion (called only by client.ts) ──

export function setRun(run: RunView): void {
  // A new run is a boundary for the agent registry too: the previous run's
  // agents are that run's record, and leaving them beside the new run's
  // would mix two runs in one list. Cleared here — at the one door every
  // run starts through — rather than in each caller.
  agents.set({});
  // …and for the steering queue: a new run starts from absence, never
  // carrying the previous run's queued instructions.
  queuedSteers.set(0);
  // …and for the previous run's pending retirement: a retirement scheduled
  // by the last run's terminal settle must never fire into this one's
  // view.
  cancelPendingRunViewRetire();
  currentRun.set(run);
}

// ── The run view's settle and retirement ────────────────────────────────────
//
// A terminal status settles the view (the pane's clock stops, the stop verb
// vanishes, the composer routes the next send to a NEW run instead of the
// dead one's steer door) and then RETIRES it after a brief delay, so the
// reader sees the outcome before the pane returns to its resting state.
// Both halves live HERE — beside the terminal vocabulary they read — not in
// each SSE listener, so a terminal door cannot forget a settle it never
// owned: the doors report statuses, this owner decides the lifetime.

let runViewRetireTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Retire the view only if the run's status still reads terminal. The
 * callback re-reads the CURRENT view, so a retirement scheduled by one
 * terminal door never fires into a run a later frame reopened — and the
 * agent registry is kept, exactly as a direct `retireRunView` keeps it.
 */
function retireRunViewIfSettled(): void {
  const run = currentRun.get();
  if (run !== null && isTerminalRunStatus(run.status)) {
    retireRunView();
  }
}

/** Arm the view's retirement, replacing any earlier arm. */
function scheduleRunViewRetire(): void {
  if (runViewRetireTimer !== null) clearTimeout(runViewRetireTimer);
  runViewRetireTimer = setTimeout(() => {
    runViewRetireTimer = null;
    retireRunViewIfSettled();
  }, RUN_STATUS_CLEAR_DELAY_MS);
}

/**
 * Drop any pending run-view retirement. A live status report cancels it: a
 * retirement can only have been scheduled by a terminal settle, and a run
 * whose turn is opening (a steered drain reopening after a terminal-looking
 * frame raced in from another door) is not settling.
 */
function cancelPendingRunViewRetire(): void {
  if (runViewRetireTimer === null) return;
  clearTimeout(runViewRetireTimer);
  runViewRetireTimer = null;
}

/**
 * Report the run's status. THE VIEW'S SETTLE LIVES HERE, at the status
 * vocabulary's owner — never in the listener that observes the frame.
 *
 * A terminal status settles the view and schedules its retirement: every
 * terminal frame (done, cancelled, error — and any terminal state the
 * vocabulary gains later) arrives through its own listener, and the
 * listener that forgets the settle is the defect this shape makes
 * impossible. A non-terminal report (a turn opening) cancels a pending
 * retirement instead, so a retirement never fires into a live run.
 */
export function updateRunStatus(status: RunStatus): void {
  const run = currentRun.get();
  if (run) currentRun.set({ ...run, status });
  if (isTerminalRunStatus(status)) {
    // Nothing to retire when no view exists — the retirement is for the view.
    if (run !== null) scheduleRunViewRetire();
  } else {
    cancelPendingRunViewRetire();
  }
}

export function upsertAgent(agent: AgentState): void {
  agents.setKey(agent.agentId, agent);
}

export function resetRunState(): void {
  currentRun.set(null);
  agents.set({});
  queuedSteers.set(0);
  cancelPendingRunViewRetire();
}

/**
 * The run ENDED (the done/error badge has been shown long enough): the run
 * view clears, but the AGENT REGISTRY STAYS. A finished run's delegated
 * agents are the chat's true record — the run pane exists to inspect them
 * — and clearing them three seconds after completion made the inspector
 * forget exactly what it exists to show. The registry is cleared by the two
 * real boundaries instead: a new run starting (`setRun`) and a chat switch
 * (`registerContextReset` below).
 *
 * Named for what it does — it RETIRES the run view, it does not reset the
 * store (the registry is deliberately kept).
 */
export function retireRunView(): void {
  currentRun.set(null);
  queuedSteers.set(0);
}

registerReset("runState", resetRunState);
// Also reset on chat switch — the run view + agent registry are per-chat
// (a run belongs to exactly one chat). Without this, switching from chat A
// (with an active run) to chat B (no run) leaves chat A's run view +
// agents on chat B's view until chat B starts a new run (possibly
// never). The SSE stream updates quickly on the same machine, so the
// brief "idle" state before the new chat's run (if any) loads is
// imperceptible + correct (a freshly-loaded chat shows "idle" until its
// run state is known, NOT the previous chat's run).
registerContextReset("runState", resetRunState);

// Re-export for testing convenience
export type { ReadableAtom };
