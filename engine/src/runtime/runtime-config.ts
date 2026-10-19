import { InputError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import type { ConfigDocument } from "../kernel/config-contracts.ts";
import type { ProviderConfig } from "./provider-adapter.ts";

/**
 * Resolves runtime configuration from the central config document.
 *
 * The config document has an optional `runtime` section declaring
 * providers, models, retry budgets, and defaults. This module extracts
 * and validates the active provider/model configuration so the CLI and
 * interactive session can consume it without re-implementing validation.
 */

export type RuntimeConfig = Readonly<{
  /**
   * Undefined when the config declares none — which is the CHECKED-IN state:
   * no provider or model ever ships in the repository file (the same
   * decision the web bridge enforces with its database-only credential).
   * Consumers resolve through `resolveProvider`/`resolveModel`, whose typed
   * refusals name what is missing and where to declare it.
   */
  defaultProvider: string | undefined;
  defaultModel: string | undefined;
  systemPrompt: string;
  defaultToolChoice: "auto" | "none" | "required";
  providers: readonly ProviderConfig[];
  models: Readonly<Record<string, Readonly<Record<string, Readonly<{ maxTokens: number; temperature: number }>>>>>;
  apiKeyEnvVars: Readonly<Record<string, string>>;
}>;

export function resolveRuntimeConfig(document: ConfigDocument): RuntimeConfig {
  const runtime = document.runtime;
  if (runtime === undefined) {
    throw new InputError(
      "Configuration has no 'runtime' section — add provider/model configuration to bridlewise.config.json",
      "runtime_config_missing",
    );
  }
  const providers: ProviderConfig[] = runtime.providers.map((p) =>
    deepFreeze({
      id: p.id,
      baseUrl: p.baseUrl,
      timeoutMs: p.timeoutMs,
      retries: deepFreeze({ ...p.retries }),
      responsesPath: p.responsesPath,
      responses: runtime.responses,
    }),
  );
  const models: Record<string, Record<string, { maxTokens: number; temperature: number }>> = Object.create(null);
  for (const p of runtime.providers) {
    const providerModels: Record<string, { maxTokens: number; temperature: number }> = Object.create(null);
    for (const m of p.models) {
      providerModels[m.id] = deepFreeze({ maxTokens: m.maxTokens, temperature: m.temperature });
    }
    models[p.id] = providerModels;
  }
  const apiKeyEnvVars: Record<string, string> = Object.create(null);
  for (const p of runtime.providers) {
    apiKeyEnvVars[p.id] = p.apiKeyEnvVar;
  }
  return deepFreeze({
    defaultProvider: runtime.defaultProvider,
    defaultModel: runtime.defaultModel,
    systemPrompt: runtime.systemPrompt,
    defaultToolChoice: runtime.defaultToolChoice,
    providers: deepFreeze(providers),
    models: deepFreeze(models),
    apiKeyEnvVars: deepFreeze(apiKeyEnvVars),
  });
}

export function resolveProvider(runtime: RuntimeConfig, providerId?: string): ProviderConfig {
  const id = providerId ?? runtime.defaultProvider;
  // MISSING CONFIGURATION IS A GUIDED STATE. No provider was named and none
  // is declared — say what is missing and where to set it, and never invent
  // a vendor: there is no provider this code is entitled to assume.
  if (id === undefined) {
    throw new InputError(
      "No provider was named and the configuration declares none. Add a provider (with its " +
        "models and apiKeyEnvVar) under `runtime.providers` in bridlewise.config.json and " +
        "either name it per call or set `runtime.defaultProvider`.",
      "runtime_provider_not_found",
    );
  }
  const provider = runtime.providers.find((p) => p.id === id);
  if (provider === undefined) {
    throw new InputError(
      `Provider '${id}' is not configured`,
      "runtime_provider_not_found",
    );
  }
  return provider;
}

export function resolveModel(
  runtime: RuntimeConfig,
  providerId?: string,
  modelId?: string,
): Readonly<{ modelId: string; maxTokens: number; temperature: number }> {
  const pid = providerId ?? runtime.defaultProvider;
  const mid = modelId ?? runtime.defaultModel;
  if (pid === undefined) {
    throw new InputError(
      "No provider was named and the configuration declares none. Add a provider under " +
        "`runtime.providers` in bridlewise.config.json and either name it per call or set " +
        "`runtime.defaultProvider`.",
      "runtime_provider_not_found",
    );
  }
  const provider = runtime.providers.find((p) => p.id === pid);
  if (provider === undefined) {
    throw new InputError(`Provider '${pid}' is not configured`, "runtime_provider_not_found");
  }
  if (mid === undefined) {
    throw new InputError(
      `No model was named and the configuration declares no default. Name a model served by ` +
        `provider '${pid}', or set \`runtime.defaultModel\` in bridlewise.config.json.`,
      "runtime_model_not_found",
    );
  }
  const model = Object.hasOwn(runtime.models, pid) && Object.hasOwn(runtime.models[pid]!, mid) ? runtime.models[pid]![mid] : undefined;
  if (model === undefined) {
    throw new InputError(
      `Model '${mid}' is not configured for provider '${pid}'`,
      "runtime_model_not_found",
    );
  }
  return deepFreeze({ modelId: mid, maxTokens: model.maxTokens, temperature: model.temperature });
}

// ── Runtime operational defaults (no configurables outside config) ──
// These numeric defaults were previously scattered as local const declarations
// in git-tools.ts and interactive-session.ts. Consolidated here (the canonical
// runtime config owner) so the no-hardcoded-configurables prevention test passes.
export const DEFAULT_CONTEXT_LINES = 3;
export const DEFAULT_MAXIMUM_TOOL_ITERATIONS = 10;

// ── Runtime tool operational limits (R45: single canonical owner, ) ──
// Previously scattered as local const declarations + inline literals across
// the runtime tool modules (git-tools, quality-tools, intelligence-tools,
// agent-tools, provider-adapter). Consolidated here so there is ONE owner
// for every runtime tool limit (Single-Party-Owner) and no bare magic numbers
// live in the tool modules. `runtime-config.ts` is a canonical-config owner
// (basename contains "config"), so the no-hardcoded-configurables prevention
// test allowlists it. Values are preserved exactly — only the location moved.
/** Maximum number of git-log entries a single `git_log` tool call can return. */
export const GIT_MAX_LOG_ENTRIES = 100;
/** Default `maxCount` for the `git_log` tool when the model omits it. */
export const GIT_DEFAULT_LOG_COUNT = 20;
/** Maximum length (bytes) of a commit message accepted by the `git_commit` tool. */
export const GIT_MAX_MESSAGE_LENGTH = 4_096;
/** A diff larger than `maxOutputBytes × STATS_ONLY_FACTOR` returns stats only. */
export const GIT_STATS_ONLY_FACTOR = 8;
/** Cap on per-file summary entries so the diff summary itself stays bounded. */
export const GIT_MAX_SUMMARY_FILES = 200;
/** Maximum length (chars) of a git ref / branch name / start-point argument. */
export const GIT_REF_MAX_LENGTH = 256;
/** Maximum `contextLines` value for the `git_diff` tool (default is DEFAULT_CONTEXT_LINES). */
export const GIT_CONTEXT_LINES_MAX = 64;
/** Maximum `maximumTurns` value for the `delegate_to_orchestrator` tool. */
export const ORCHESTRATOR_MAX_TURNS = 1000;
/** Maximum number of files a single quality-check tool call inspects. */
export const QUALITY_MAX_FILES = 256;
/** Default + max `limit` for the `search_symbols` intelligence tool. */
export const SYMBOL_SEARCH_DEFAULT_LIMIT = 50;
export const SYMBOL_SEARCH_MAX_LIMIT = 200;
/** Default + max `limit` for the `find_reuse` intelligence tool. */
export const REUSE_SEARCH_DEFAULT_LIMIT = 20;
export const REUSE_SEARCH_MAX_LIMIT = 100;
/** Maximum length (chars) of an agent name + task in the agent tools. */
export const AGENT_NAME_MAX_LENGTH = 256;
export const AGENT_TASK_MAX_LENGTH = 16_384;
/**
 * Provider request concurrency cap. Preserves the legacy "effectively
 * unbounded" behavior (a high cap keeps the queue from blocking legacy
 * callers while still bounding runaway parallelism).
 */
export const PROVIDER_CONCURRENCY = 1024;
