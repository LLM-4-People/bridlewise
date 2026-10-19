/**
 * nanostores shared state: tool manifest (built-in + MCP, tagged with
 * category) + id lookup + category filters + enabled-set overlay.
 *
 * Plain.ts — Node-testable via Vitest. Fed ONLY by client.ts (setTools).
 *
 * the manifest now carries a `category` ("built-in" | "mcp") so the
 * Tools panel shows ONE merged list with a category badge. The enabled set
 * is the config's `tools.enabled` list projected onto the manifest — a tool
 * not in the enabled set is disabled (not sent to the LLM). When the enabled
 * set is empty, ALL built-in tools are enabled (the backward-compatible
 * default — no tool is silently dropped).
 *
 * @global-store tool manifest fetched per-user (not chat-scoped; same for every chat)
 */

import { atom, computed, type ReadableAtom } from "nanostores";

import type { WebToolEntry } from "../../shared/types";
import { registerReset } from "./store-registry";

// ── Stores ──

export const toolManifest = atom<readonly WebToolEntry[]>([]);

/** The `tools.enabled` list from the config (empty = all enabled). */
export const enabledTools = atom<readonly string[]>([]);

export const toolCount: ReadableAtom<number> = computed(
  toolManifest,
  (list) => list.length,
);

export const toolById: ReadableAtom<ReadonlyMap<string, WebToolEntry>> = computed(
  toolManifest,
  (list) => new Map(list.map((t) => [t.id, t] as const)),
);

export const toolByName: ReadableAtom<ReadonlyMap<string, WebToolEntry>> = computed(
  toolManifest,
  (list) => new Map(list.map((t) => [t.name, t] as const)),
);

// ── Derived projections (the manifest is the single owner) ──

/**
 * The plain-words label for a tool, read off the served manifest — never a
 * hand table. The label is a field the backend declares at registration
 * (`label` on the manifest entry), so a renamed tool needs no frontend edit:
 * the manifest the server serves already carries the new name's label.
 *
 * A name absent from the manifest (not loaded yet, or a name nothing serves)
 * renders as its name with underscores spaced — the fallback, never a
 * bespoke second answer.
 */
export function toolLabel(name: string): string {
  const entry = toolByName.get().get(name);
  return entry?.label ?? name.replaceAll("_", " ");
}

/**
 * The names of the tools whose successful calls change a file on disk.
 * Derived from the manifest's declared capabilities: a tool carrying the
 * `write` capability changes the world. Never a hand-maintained list — a
 * tool registered tomorrow with `write` lands here automatically.
 */
export function fileEffectToolNames(): ReadonlySet<string> {
  const out = new Set<string>();
  for (const t of toolManifest.get()) {
    if (t.capabilities.includes("write")) out.add(t.name);
  }
  return out;
}

// ── Ingestion (called only by client.ts) ──

export function setTools(tools: readonly WebToolEntry[]): void {
  toolManifest.set(tools);
}

export function setEnabledTools(names: readonly string[]): void {
  enabledTools.set(names);
}

export function resetTools(): void {
  toolManifest.set([]);
  enabledTools.set([]);
}

registerReset("tools", resetTools);
