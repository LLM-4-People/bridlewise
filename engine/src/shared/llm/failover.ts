/** Provider/model resolution and finite operation-local failover selection. */
import { LLMError, type ErrorType } from "./errors.ts";
import type { HeldSet } from "../../privacy/held-set.ts";
import type { FailoverConfig, FailoverStrategy, ModelConfig, ProviderEntry, ResolvedLLMConfig } from "./config.ts";
import { providerHeldSet, observeProviderLabel, observeProviderOrigin, opaqueProviderLocator } from "./provider-observation.ts";
export type FailoverTarget = Readonly<{
  model: string | undefined; providerId: string; baseUrl: string; apiKey: string; allowPrivateAddress: boolean; timeoutMs: number;
  concurrency: number; headers: Readonly<Record<string, string>>; responsesPath: string;
  requestDefaults: import("./responses.ts").ResponsesDefaults; maxRetries: Readonly<Record<ErrorType, number>>;
}>;
export type SafeProviderTarget = Readonly<Pick<FailoverTarget, "model" | "providerId" | "baseUrl" | "timeoutMs" | "concurrency" | "responsesPath">>;
export function safeProviderTarget(target: FailoverTarget, heldCredentials?: HeldSet): SafeProviderTarget {
  const held = providerHeldSet(target).merge(heldCredentials);
  return Object.freeze({ model: target.model === undefined ? undefined : observeProviderLabel(target.model, held), providerId: observeProviderLabel(target.providerId, held), baseUrl: observeProviderOrigin(target.baseUrl, held),
    timeoutMs: target.timeoutMs, concurrency: target.concurrency, responsesPath: opaqueProviderLocator() });
}
export function targetIdentity(target: Pick<FailoverTarget, "model" | "providerId">): string { return JSON.stringify([target.providerId, target.model]); }
export class FailoverSelector {
  private readonly config: ResolvedLLMConfig;
  private readonly targets: readonly FailoverTarget[];
  private index = 0;
  private readonly latency = new Map<string, number>();
  constructor(config: ResolvedLLMConfig) {
    this.config = config;
    this.targets = config.failover.enabled
      ? (config.failover.models.length ? config.failover.models : [config.model]).flatMap(model =>
        (config.failover.providers.length ? config.failover.providers : [config.providerId]).map(provider => this.resolve(model, provider)))
      : [this.resolve(config.model, config.providerId)];
  }
  resolve(model: string | undefined, providerId: string, origin?: FailoverTarget): FailoverTarget {
    const c = this.config, provider = c.providers.find(p => p.id === providerId), override = c.models.find(m => m.model === model && (m.providerId ?? c.providerId) === providerId);
    if (!provider && providerId !== c.providerId) throw new LLMError("Unknown provider target", "llm_config_invalid", "bad-request", false);
    return Object.freeze({ model, providerId, baseUrl: provider?.baseUrl.replace(/\/+$/u, "") ?? c.baseUrl,
      apiKey: provider?.apiKey ?? c.apiKey, allowPrivateAddress: c.allowPrivateAddress, timeoutMs: override?.timeout ?? provider?.timeout ?? c.timeoutMs,
      concurrency: override?.concurrency ?? provider?.concurrency ?? c.concurrency,
      headers: Object.freeze({ ...c.headers, ...provider?.headers }), responsesPath: provider?.responsesPath ?? c.responsesPath,
      requestDefaults: Object.freeze({ ...c.requestDefaults, ...provider?.requestDefaults, ...override?.requestDefaults }),
      maxRetries: Object.freeze({ ...c.maxRetries, ...provider?.retries, ...override?.retries }),
      ...(origin === undefined ? {} : { baseUrl: origin.baseUrl, apiKey: origin.apiKey, headers: origin.headers, responsesPath: origin.responsesPath }),
    });
  }
  enabled(): boolean { return this.config.failover.enabled && this.targets.length > 1; }
  current(): FailoverTarget { return this.targets[this.index]!; }
  candidates(): readonly FailoverTarget[] { return this.targets; }
  currentIndex(): number { return this.index; }
  targetsCount(): number { return this.targets.length; }
  shouldFailover(errorType: ErrorType, visited: ReadonlySet<string> = new Set([targetIdentity(this.current())])): boolean {
    return this.enabled() && !!this.config.failover.triggerOnError?.includes(errorType) && this.targets.some(t => !visited.has(targetIdentity(t)));
  }
  next(visited: ReadonlySet<string> = new Set([targetIdentity(this.current())])): FailoverTarget | undefined {
    let candidates = this.targets.map((target, index) => ({ target, index })).filter(x => !visited.has(targetIdentity(x.target)));
    if (this.config.failover.strategy === "least-latency") candidates = candidates.sort((a, b) =>
      (this.latency.get(targetIdentity(a.target)) ?? 0) - (this.latency.get(targetIdentity(b.target)) ?? 0));
    else if (this.config.failover.strategy === "round-robin") candidates = candidates.sort((a, b) =>
      (a.index - this.index - 1 + this.targets.length) % this.targets.length - (b.index - this.index - 1 + this.targets.length) % this.targets.length);
    const selected = candidates[0];
    if (!selected) return undefined;
    this.index = selected.index;
    return selected.target;
  }
  recordStart(_index: number): void { /* Attempt counts belong to the stats owner. */ }
  recordLatency(index: number, ms: number): void {
    const target = this.targets[index];
    if (target && Number.isFinite(ms) && ms >= 0) this.latency.set(targetIdentity(target), ms);
  }
}
export function defaultFailoverConfig(): FailoverConfig { return { enabled: false, models: [], providers: [], strategy: "round-robin" }; }
export type { FailoverConfig, FailoverStrategy, ModelConfig, ProviderEntry };
