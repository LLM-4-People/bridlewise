/**
 * nanostores shared state: frozen config snapshot.
 *
 * Plain.ts — Node-testable via Vitest. Fed ONLY by client.ts (setConfig).
 * The config snapshot is read-only UI context (model/provider info, roots);
 * it is never mutated locally.
 *
 * @global-store server config snapshot (not chat-scoped; shared across all chats)
 */

import { atom, computed, type ReadableAtom } from "nanostores";

import { registerReset } from "./store-registry";

import type { ConfigSnapshot } from "../../shared/types";

// ── Stores ──

export const configSnapshot = atom<ConfigSnapshot | null>(null);

export const isConfigLoaded: ReadableAtom<boolean> = computed(
  configSnapshot,
  (s) => s !== null,
);

// ── Ingestion (called only by client.ts) ──

export function setConfig(snapshot: ConfigSnapshot): void {
  configSnapshot.set(snapshot);
}

export function resetConfig(): void {
  configSnapshot.set(null);
}

registerReset("config", resetConfig);
