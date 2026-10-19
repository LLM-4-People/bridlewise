
import { DEFAULT_MEMORY_PREVIEW_CHARS } from "./memory-config.ts";

export function extractFirstSentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";
  const sentenceEnd = trimmed.search(/[.!?]\s/u);
  if (sentenceEnd === -1) return trimmed.slice(0, DEFAULT_MEMORY_PREVIEW_CHARS);
  return trimmed.slice(0, sentenceEnd + 1).trim();
}

export function contextRemoveTurn<T extends { turnId: string }>(turnId: string, activeTurns: T[]): boolean {
  const idx = activeTurns.findIndex((t) => t.turnId === turnId);
  if (idx === -1) return false;
  activeTurns.splice(idx, 1);
  return true;
}

export function contextGetTurn<T>(turnId: string, allTurnsById: Map<string, T>): T | null {
  return allTurnsById.get(turnId) ?? null;
}

export function contextReplaceTurns<T extends { turnId: string }>(turns: readonly T[], activeTurns: T[], allTurnsById: Map<string, T>): void {
  activeTurns.length = 0;
  for (const turn of turns) {
    activeTurns.push(turn);
    allTurnsById.set(turn.turnId, turn);
  }
}

export function contextIsOverThreshold(tokenCount: () => number, trimThresholdTokens: () => number): boolean {
  return tokenCount() > trimThresholdTokens();
}

export function contextShouldTrim(tokenCount: () => number, trimThresholdTokens: () => number): boolean {
  return tokenCount() >= trimThresholdTokens();
}
