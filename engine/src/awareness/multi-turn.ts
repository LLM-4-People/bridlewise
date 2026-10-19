/**
 * EXP387 — Multi-turn awareness engine.
 *
 * Wraps the awareness engine with multi-turn delta tracking. The LLM
 * conversation is a sequence of turns:
 *
 * turn 1: LLM sees <awareness block> + user prompt → produces edit.
 * turn 2: engine recomputes (only changed files via cache) → LLM sees
 * <awareness block> + <AFTER YOUR LAST EDIT:... delta> + prompt.
 * turn 3: same.
 *...
 *
 * The delta tells the LLM what CHANGED after its edit, so it can
 * verify its impact in real-time. The user's directive: "the info we
 * feed to the llm must be dynamically updated in real time somehow,
 * so that after many multi turns, it is still relevant".
 *
 * Usage:
 *
 * const mt = createMultiTurnEngine(cfg, { runGit: runGitDirectly });
 * const turn1 = mt.compute(path); // { snapshot, delta: null (first turn) }
 * //... LLM edits a file...
 * const turn2 = mt.compute(path); // { snapshot, delta: { lines: [...] } }
 * // The delta shows the LLM's impact.
 */
import type { AwarenessConfig } from "./config.ts";
import type { AwarenessSnapshot } from "./types.ts";
import { createAwarenessEngine, type AwarenessEngineDependencies } from "./engine.ts";
import { computeDelta, type AwarenessDelta } from "./delta.ts";

export interface MultiTurnResult {
  /** The new snapshot (current codebase state). */
  snapshot: AwarenessSnapshot;
  /** The delta vs the previous turn (null on the first turn). */
  delta: AwarenessDelta | null;
  /** The text to prepend to the LLM's prompt: awareness block + delta. */
  promptText: string;
  /** Turn number (1-indexed). */
  turn: number;
}

/**
 * Create a multi-turn engine. Keeps the last snapshot internally.
 *
 * ── WHY THIS TAKES THE SAME DEPENDENCY THE ENGINE DOES ────────────────────
 *
 * It used to take only a config and hard-code `runGit: runGitDirectly`, with a
 * comment explaining that this path "belongs to the command-line harness,
 * which has already confined its own process". That is a claim about the
 * world, made by a module that cannot check it, and the TYPE said the
 * opposite: `createAwarenessEngine` was deliberately changed so that a host
 * which does not say how git may be run does not compile — because the engine
 * ran git through a shell on the user-selected project, and the project's own
 * `.git/config` chose the program git executed.
 *
 * A wrapper that supplies the dependency is a second door into the same
 * capability, and it is the door with no compile error behind it. Nothing in
 * production called it, so nothing was exploitable — but a dormant second path
 * is how the capability comes back, and a guard was actively asserting the
 * line existed, which pinned it open.
 *
 * So the obligation passes STRAIGHT THROUGH. This module no longer imports a
 * runner, no longer reaches the process-creating module, and the rung-3
 * guarantee now holds at every door rather than only at the inner one.
 */
export function createMultiTurnEngine(
  config: AwarenessConfig,
  dependencies: AwarenessEngineDependencies,
): {
  compute: (rootPath: string) => MultiTurnResult;
  reset: () => void;
  turn: () => number;
} {
  const engine = createAwarenessEngine(config, dependencies);
  let lastSnapshot: AwarenessSnapshot | null = null;
  let turnNumber = 0;

  function compute(rootPath: string): MultiTurnResult {
    turnNumber += 1;
    const snapshot = engine.compute(rootPath);
    let delta: AwarenessDelta | null = null;
    if (lastSnapshot !== null) {
      delta = computeDelta(lastSnapshot, snapshot);
    }
    // Compose the prompt text: awareness block + delta.
    let promptText = snapshot.compactBlock;
    if (delta && delta.lines.length > 0) {
      promptText += "\n\n" + delta.text;
    } else if (delta) {
      // Delta exists but no signal changed — still show the reanalyzed count.
      promptText += "\n\n" + delta.text;
    }
    lastSnapshot = snapshot;
    return { snapshot, delta, promptText, turn: turnNumber };
  }

  function reset(): void {
    engine.clearCache();
    lastSnapshot = null;
    turnNumber = 0;
  }

  return { compute, reset, turn: () => turnNumber };
}
