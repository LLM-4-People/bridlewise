/** Bounded, provider-scoped response ownership; this never cancels remote work. */
import { InputError } from "../../kernel/errors.ts";
import type { MintedRequestContext } from "../../privacy/redacted-messages.ts";
import type { FailoverTarget } from "./failover.ts";

type Entry = { id: string; target: FailoverTarget; observation?: MintedRequestContext; pending: boolean; usage: "unreported" | "unavailable" | "recorded" };
export class ResponsesTracker {
  readonly #entries = new Map<string, Entry>();
  #pending = 0;
  #reserved = 0;
  #unavailableUsage = 0;
  #evictedUnavailableUsage = 0;
  readonly limit: number;
  constructor(limit: number) { this.limit = limit; }

  reserve(): Readonly<{ observe: (id: string, target: FailoverTarget, observation?: MintedRequestContext) => void; release: () => void }> {
    if (this.#pending + this.#reserved >= this.limit) throw new InputError("Pending Responses ownership is at its configured bound", "responses_pending_limit");
    this.#reserved++;
    let reserved = true;
    let observedKey: string | undefined;
    const release = (): void => { if (reserved) { reserved = false; this.#reserved--; } };
    return { release, observe: (id, target, observation) => {
      const key = responseKey(id, target.providerId);
      if (observedKey !== undefined) {
        if (observedKey !== key) throw new InputError("A create operation changed response identity", "responses_identity_changed");
        return;
      }
      observedKey = key;
      if (!this.#entries.has(key)) {
        this.#entries.set(key, { id, target, ...(observation === undefined ? {} : { observation }), pending: true, usage: "unreported" }); this.#pending++;
      }
      release(); this.#prune();
    } };
  }

  origin(id: string, provider?: string): FailoverTarget | undefined {
    if (provider !== undefined) return this.#entries.get(responseKey(id, provider))?.target;
    const entries = [...this.#entries.values()].filter(entry => entry.id === id);
    if (entries.length > 1) throw new InputError("This response ID exists at multiple providers; specify its origin", "responses_provider_required");
    return entries[0]?.target;
  }

  /** Private original detector/credential context follows owned resources through lifecycle reads. */
  observation(id: string, provider: string): MintedRequestContext | undefined {
    return this.#entries.get(responseKey(id, provider))?.observation;
  }

  /** Only a validated terminal resource can claim usage; capacity is independent. */
  settle(id: string, provider: string, usageAvailable: boolean): FailoverTarget | undefined {
    const entry = this.#entries.get(responseKey(id, provider));
    if (!entry) return undefined;
    if (entry.pending) { entry.pending = false; this.#pending--; }
    if (entry.usage === "recorded") return undefined;
    if (usageAvailable) {
      if (entry.usage === "unavailable") this.#unavailableUsage--;
      entry.usage = "recorded";
      return entry.target;
    }
    if (entry.usage === "unreported") { entry.usage = "unavailable"; this.#unavailableUsage++; }
    return undefined;
  }

  retire(id: string, provider?: string): FailoverTarget | undefined {
    const target = this.origin(id, provider);
    if (!target) return undefined;
    const entry = this.#entries.get(responseKey(id, target.providerId))!;
    if (!entry.pending) return undefined;
    this.settle(id, target.providerId, false);
    return target;
  }

  /** A retained handle cannot acquire authority over a later entry reusing an opaque ID. */
  retirement(id: string, provider: string): () => FailoverTarget | undefined {
    const key = responseKey(id, provider), accepted = this.#entries.get(key);
    return () => accepted !== undefined && this.#entries.get(key) === accepted ? this.retire(id, provider) : undefined;
  }

  snapshot() {
    return Object.freeze({ tracked: this.#entries.size, pending: this.#pending, reserved: this.#reserved,
      unavailableUsage: this.#unavailableUsage, evictedUnavailableUsage: this.#evictedUnavailableUsage, limit: this.limit });
  }

  #prune(): void {
    while (this.#entries.size > this.limit) {
      const settled = [...this.#entries].find(([, entry]) => !entry.pending);
      if (!settled) throw new InputError("Response ownership exceeded its admission bound", "responses_pending_limit");
      if (settled[1].usage === "unavailable") { this.#unavailableUsage--; this.#evictedUnavailableUsage++; }
      this.#entries.delete(settled[0]);
    }
  }
}
function responseKey(id: string, provider: string): string { return JSON.stringify([provider, id]); }
