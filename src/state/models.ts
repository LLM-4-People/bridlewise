/**
 * nanostores shared state: available LLM models + the user's selection.
 *
 * Plain.ts — Node-testable via Vitest without any Svelte compiler.
 *
 * Boundary rule: the models LIST is backend-originating and is fed ONLY by
 * client.ts (setModels). The selectedModelId selection is UI-originated
 * shared state: components may call selectModel directly (it is a pure UI
 * selection, not backend data). The ChatPanel reads `currentModelId` to
 * pass the chosen model with each run/start request.
 *
 * The backend `/api/models` endpoint is the canonical source — models are
 * defined in the harness config, never hardcoded in the frontend.
 *
 * @global-store model list fetched per-user (not chat-scoped; same for every chat)
 */

import { atom, computed, type ReadableAtom } from "nanostores";

import { registerReset } from "./store-registry";

// ── Types (canonical owner for the web-slice client view) ──

export type ModelInfo = Readonly<{
  readonly id: string;
  /**
   * The context window this model declares — what one request can hold,
   * input and output together. Absent means the model declared nothing and
   * the harness-wide limit governs (the same honesty the stored schema
   * uses — never a guessed number).
   */
  readonly contextWindow?: number;
  /** Cap on this model's reply length, sent when the model declares one. */
  readonly maxTokens?: number;
  /** This model's sampling default, sent when the model declares one. */
  readonly temperature?: number;
}>;

export type ProviderInfo = Readonly<{
  readonly id: string;
  readonly baseUrl: string;
  readonly models: readonly ModelInfo[];
  /**
   * Whether this provider has an API key saved. NOT the key — the server has
   * no field to put one in. It is the only fact the UI needs in order to show
   * a provider as finished or as still owing a key.
   */
  readonly hasApiKey: boolean;
  /**
   * The NAMES of the custom request headers saved on this provider — never
   * the values, which can be secret-shaped. Optional so a provider with none
   * (the common case) carries nothing; the settings surface treats absent as
   * "no extra headers".
   */
  readonly headerNames?: readonly string[];
}>;

export type ModelsCatalog = Readonly<{
  readonly providers: readonly ProviderInfo[];
  readonly defaultProvider: string | null;
  readonly defaultModel: string | null;
  /**
   * The user has saved no provider, so there is nothing to run against yet.
   *
   * A first-class STATE, not an error and not an empty dropdown. The UI reads
   * this to show the setup surface; before it existed the same situation
   * arrived as a 503 naming a file path, which the client could only render as
   * a failure of the server.
   */
  readonly setupRequired: boolean;
  /** What to do about it, in the same words a refused run shows. */
  readonly setupRemedy: string;
}>;

// ── Stores ──

export const modelsCatalog = atom<ModelsCatalog | null>(null);
export const selectedModelId = atom<string | null>(null);

/** Flat list of all models across providers (for the picker dropdown).
 * FIX: deduplicate by model id — if the same model id appears under
 * multiple providers, it appears only once in the picker. */
export const allModels: ReadableAtom<readonly ModelInfo[]> = computed(
  modelsCatalog,
  (catalog) => {
    if (catalog === null) return [];
    const list: ModelInfo[] = [];
    const seen = new Set<string>();
    for (const p of catalog.providers) {
      for (const m of p.models) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        list.push(m);
      }
    }
    return list;
  },
);

/** The currently selected model, or the default model from the catalog. */
export const currentModelId: ReadableAtom<string | null> = computed(
  [selectedModelId, modelsCatalog],
  (sel, catalog) => {
    if (sel !== null) return sel;
    if (catalog === null) return null;
    return catalog.defaultModel;
  },
);

/** The provider id for the currently selected model (or null). */
export const currentProviderId: ReadableAtom<string | null> = computed(
  [currentModelId, modelsCatalog],
  (modelId, catalog) => {
    if (catalog === null || modelId === null) return null;
    for (const p of catalog.providers) {
      if (p.models.some((m) => m.id === modelId)) return p.id;
    }
    return null;
  },
);

// ── Ingestion ──

export function setModels(catalog: ModelsCatalog): void {
  modelsCatalog.set(catalog);
}

export function selectModel(id: string | null): void {
  selectedModelId.set(id);
}

export function resetModels(): void {
  modelsCatalog.set(null);
  selectedModelId.set(null);
}

registerReset("models", resetModels);
