// src/agents/stigmergy-coordination.ts
//
// ACO2 Stigmergy coordination — EXP442/EXP455 POSITIVE finding (design
// validated, no new merge required — the orchestrator already
// coordinates via an AwarenessStore).
//
// Stigmergy (Grassé 1959) is indirect coordination through the
// environment: agents leave "signals" in a shared store (the
// AwarenessStore), and other agents read those signals to decide their
// next action — WITHOUT direct messaging. Ant colonies coordinate this
// way (pheromone trails); the orchestrator's AwarenessStore is the
// digital equivalent.
//
// EXP442 measured: coordination overhead 17 dispatch+depchecks → 5
// board-reads for a 7-step 5-agent task. Both complete 7/7.
//
// Research sources:
// - EXP442 (`novel-principles`): ACO2 stigmergy confirmed POSITIVE.
// - Grassé (1959) "La reconstruction du nid et les coordinations
// interindividuelles chez Bellicositermes Natalensis": the original
// stigmergy definition.
// - Dorigo (1992) "Optimization, Learning and Natural Algorithms":
// ACO formalization.
// - EXP455 merge manifest: ACO2 marked "DESIGN VALIDATED (orchestrator
// already stigmergic)" — `src/agents/orchestrator.ts` already has an
// AwarenessStore. This module DOCUMENTS the stigmergic contract and
// exposes helper functions so future agents can read/write the
// shared board with consistent semantics.
//
// Public API:
// - `stigmergyPublishProgress(store, agentName, taskId, message)` —
// publish a progress entry to the awareness board.
// - `stigmergyReadForAgent(store, agentName)` — read all entries
// relevant to an agent (its own + the global board).
// - `stigmergyReadForTask(store, taskId)` — read all entries for a task.
// - `stigmergySignal(store, agentName, taskId, kind, content)` —
// publish a typed signal (the ACO analogue of a pheromone deposit).
//
// No code extracted from external sources; the stigmergy pattern is a
// thin wrapper over the existing AwarenessStore.

import { deepFreeze } from "../kernel/integrity.ts";
import type { AwarenessStore, AwarenessEntry } from "./orchestrator.ts";

export type StigmergySignalKind =
  | "progress" // agent started/finished a step
  | "blocker" // agent hit a blocker that another agent might resolve
  | "claim" // agent claimed a file/resource
  | "release" // agent released a file/resource
  | "result"; // agent produced a result another agent consumes

export type StigmergySignal = Readonly<{
  agentName: string;
  taskId: string;
  kind: StigmergySignalKind;
  content: string;
  timestamp: string;
  turnNumber: number;
}>;

/**
 * Publish a typed stigmergy signal to the awareness store. The signal
 * is the ACO analogue of a pheromone deposit — it persists in the
 * shared environment for other agents to read.
 */
export function stigmergySignal(
  store: AwarenessStore,
  agentName: string,
  taskId: string,
  kind: StigmergySignalKind,
  content: string,
  turnNumber: number = 0,
  timestamp: string = new Date().toISOString(),
): void {
  const entry: AwarenessEntry = deepFreeze({
    agentName,
    taskId,
    content: `[${kind}] ${content}`,
    timestamp,
    turnNumber,
  });
  store.publish(entry);
}

/** Convenience: publish a progress signal. */
export function stigmergyPublishProgress(
  store: AwarenessStore,
  agentName: string,
  taskId: string,
  message: string,
  turnNumber: number = 0,
): void {
  stigmergySignal(store, agentName, taskId, "progress", message, turnNumber);
}

/**
 * Read all stigmergy signals relevant to an agent: its own entries
 * PLUS all entries on the global board (so the agent can see what
 * others have published).
 */
export function stigmergyReadForAgent(
  store: AwarenessStore,
  agentName: string,
): readonly StigmergySignal[] {
  const own = store.getEntriesForAgent(agentName);
  const all = store.getEntries();
  // Dedup: own entries already appear in `all`, so we just return `all`
  // and filter to typed signals (those prefixed with `[kind]`).
  const seen = new Set<string>();
  const signals: StigmergySignal[] = [];
  for (const entry of all) {
    if (seen.has(signature(entry))) continue;
    seen.add(signature(entry));
    const parsed = parseSignal(entry);
    if (parsed !== null) signals.push(parsed);
  }
  // Ensure own entries are included even if not typed (rare).
  for (const entry of own) {
    if (seen.has(signature(entry))) continue;
    seen.add(signature(entry));
    signals.push({
      agentName: entry.agentName,
      taskId: entry.taskId,
      kind: "progress",
      content: entry.content,
      timestamp: entry.timestamp,
      turnNumber: entry.turnNumber,
    });
  }
  return deepFreeze(signals);
}

/** Read all stigmergy signals for a specific task. */
export function stigmergyReadForTask(
  store: AwarenessStore,
  taskId: string,
): readonly StigmergySignal[] {
  const entries = store.getEntriesForTask(taskId);
  const signals: StigmergySignal[] = [];
  for (const entry of entries) {
    const parsed = parseSignal(entry);
    if (parsed !== null) {
      signals.push(parsed);
    } else {
      signals.push({
        agentName: entry.agentName,
        taskId: entry.taskId,
        kind: "progress",
        content: entry.content,
        timestamp: entry.timestamp,
        turnNumber: entry.turnNumber,
      });
    }
  }
  return deepFreeze(signals);
}

/** Count signals by kind for a quick board summary (used by awareness). */
export function stigmergyBoardSummary(
  store: AwarenessStore,
): Readonly<Record<StigmergySignalKind, number>> {
  const counts: Record<StigmergySignalKind, number> = {
    progress: 0,
    blocker: 0,
    claim: 0,
    release: 0,
    result: 0,
  };
  for (const entry of store.getEntries()) {
    const parsed = parseSignal(entry);
    if (parsed !== null) {
      counts[parsed.kind] += 1;
    }
  }
  return deepFreeze(counts);
}

// --- internals ------------------------------------------------------------

function signature(entry: AwarenessEntry): string {
  return `${entry.agentName}::${entry.taskId}::${entry.timestamp}::${entry.content}`;
}

function parseSignal(entry: AwarenessEntry): StigmergySignal | null {
  const match = entry.content.match(/^\[([a-z]+)\]\s*(.*)$/s);
  if (match === null) return null;
  const kind = match[1] as StigmergySignalKind;
  if (!isStigmergySignalKind(kind)) return null;
  return deepFreeze({
    agentName: entry.agentName,
    taskId: entry.taskId,
    kind,
    content: match[2] ?? "",
    timestamp: entry.timestamp,
    turnNumber: entry.turnNumber,
  });
}

function isStigmergySignalKind(s: string): s is StigmergySignalKind {
  return s === "progress" || s === "blocker" || s === "claim" || s === "release" || s === "result";
}
