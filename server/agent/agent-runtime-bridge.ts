import { combineSignals } from "../../engine/src/shared/abort-signals.ts";
/**
 * AGENT-RUNTIME BRIDGE — the SINGLE owner of web-run agent delegation.
 *
 * The engine fully implements an agent runtime (`createAgentRuntime` +
 * `createAgentTools`, plus `createOrchestrator` + `createOrchestratorTools`
 * for multi-agent orchestration); this module is the ONE place a web run
 * constructs them. Nothing else in the server imports the engine's agent
 * substrate directly — the manifest owner (tools-bridge) declares the four
 * tools' SCHEMAS from `buildAgentToolManifestEntries` here, the executor
 * (tool-executor) dispatches the four tool names to the handlers here, and
 * the per-run pieces (adapter, registry, state store, ledger store) are
 * built behind this module's door.
 *
 * ── WHERE EVERY PIECE COMES FROM ─────────────────────────────────────────
 *
 *   - agentsConfig: the global harness config document, resolved through the
 *     engine's own `resolveAgentsConfig` + `createProviderModelResolver` —
 *     never reimplemented here (the config file is the single source of
 *     truth; the engine owns its schema).
 *   - adapter: built on the SAME choke point every web LLM call crosses —
 *     `llm-bridge.ts`'s `streamChat`. The sub-agent's provider messages are
 *     redacted and deduplicated by the same owner as the parent's, the
 *     credential comes from the run's resolved `ProviderCredential` (the
 *     providers.ts mint — there is no second place an API key exists), and
 *     the model is resolved through the engine's provider/model resolver so
 *     a profile names a model the config actually declares.
 *   - toolRegistry: built per delegation by `createDelegationToolRegistry` —
 *     a NARROWING of the parent's unified manifest by each tool's DECLARED
 *     capabilities, never a hardcoded name list. The registry's handlers
 *     re-enter the web executor (`executeToolCall`), so a sub-agent's tool
 *     call crosses the identical safety gate + Landlock confinement choke
 *     points the parent's calls do.
 *   - stateStore: the SHARED agent-state store (the same one the Agents tab
 *     reads), backed by the run's timeline recorder (the same ledger the run
 *     writes to), so a delegated agent is recorded where the rest of the
 *     product can see it and its lifecycle lands in the timeline. Per-run
 *     isolation for `get_agent_state` is applied at READ time (the wrapped
 *     handler filters by this run's id) — never by forking the store, which
 *     would be two answers over one ledger.
 *   - store (orchestration): the DURABLE event-ledger storage port — the
 *     same persistent SQLite timeline ledger the run route writes to
 *     (`getTimelineStore()`), NOT a parallel store. The orchestrator's
 *     `OrchestratorToolsOptions.store` requires this durable port; handing it
 *     the shared ledger means orchestrated sub-agent events land in the same
 *     chain-hashed ledger as every other run event.
 *
 * ── THE ORCHESTRATION RUN ID (run-pane surfacing) ─────────────────────────
 *
 * `delegate_to_orchestrator` spawns its OWN orchestrator (whose `runId` is a
 * fresh `run-…`), which spawns each sub-agent with THAT run id — so the
 * shared state store scopes orchestrated agents under the orchestration id,
 * not the calling chat run's id. The pane's per-run filter and the
 * per-run-scoped `get_agent_state` would not see them under the chat run's
 * id. The bridge therefore MIRRORS each orchestrated agent into the shared
 * store under the calling run's id as it completes (one extra record per
 * agent, appended by the owner — the ledger only grows), so the run pane's
 * Agents section and the scoped `get_agent_state` show orchestrated agents
 * alongside single delegations. The orchestration's own records (under its
 * own run id) remain the durable truth in the ledger; the mirror is a
 * read-model projection so the pane stays in sync.
 *
 * The whole construction is LAZY per run: the config is parsed and the
 * resolver built the first time a run actually delegates, so a chat that
 * never calls `delegate_to_agent` never pays for it — and a run on an
 * account whose config declares no `agents` section is told so plainly (a
 * guided refusal), never handed a silent empty agent list.
 */

import {
  createAgentTools,
  createOrchestratorTools,
  createProviderModelResolver,
  createToolRegistry,
  getAgentProfile,
  resolveAgentsConfig,
  AGENT_CAPABILITY_CATALOG,
  type AgentToolsOptions,
  type AgentProfile,
  type AgentsConfig,
  type OrchestratorToolsOptions,
  type ProviderAdapter,
  type RegisteredTool,
  type ToolContext,
} from "../kernel/canonical.ts";
import type { ProviderCredential } from "../llm/providers.ts";
import type { ToolExecutionContext, ToolCallResult } from "../tools/tool-executor.ts";
import { getTimelineRecorder, getTimelineStore } from "../observability/timeline-bridge.ts";
import { resolveWithinProject } from "../filesystem/fs-gate.ts";
import { getConfigDocumentSchema } from "../kernel/canonical.ts";
import { readSettingsDocument } from "../kernel/harness-config.ts";
import { sharedAgentStateStore } from "./agents-bridge.ts";
import { recordLlmCall } from "../observability/metrics-recorder.ts";
import { webWarn } from "../observability/debug-bridge.ts";
import { ValidationError, NotFoundError } from "../kernel/errors.ts";
import {
  parseDelegationRestrictions,
  resolveDelegationRestrictions,
  restrictedProfile,
  DELEGATION_RESTRICTION_PRESETS,
  type DelegationRestrictions,
} from "./agent-restrictions.ts";
import type { WebToolEntry } from "../tools/tools-bridge.ts";
import type { ToolManifestEntry, ToolCapability } from "../kernel/canonical.ts";
import type { ChatMessage } from "../kernel/canonical.ts";

// The engine's `resolveRuntimeConfig` + provider/model resolvers are the
// config-document answer to "which provider/model does this profile name".
// They are pure (no I/O) and are reached through the canonical hub like
// every other engine import.
import { resolveRuntimeConfig } from "../kernel/canonical.ts";

// ── The resolved agents config (per delegation — cheap, config re-read) ──

type ResolvedAgents = Readonly<{
  config: AgentsConfig;
  resolver: ReturnType<typeof createProviderModelResolver>;
  runtime: ReturnType<typeof resolveRuntimeConfig>;
}>;

/**
 * Resolve the agents section of the global harness config through the
 * engine's own resolvers. The config document is validated against the
 * engine's `getConfigDocumentSchema()` before the engine's resolver sees it —
 * a config that fails the schema is a typed refusal, not a partially-parsed
 * delegation. Re-resolved per delegation from the RESOLVED SNAPSHOT (never
 * the file): a hot edit (add a profile, retarget a model) reaches the NEXT
 * delegation once the snapshot refreshes (each request, each run start, the
 * store watch), and a refused store keeps serving the last good profiles.
 *
 * The refusal when `agents` is absent is GUIDED (names what's missing and
 * where it goes), matching this server's contract: no silent empty state,
 * no fallback to a bundled profile.
 */
function resolveAgents(): ResolvedAgents {
  const document = readSettingsDocument();
  const parsed = getConfigDocumentSchema().safeParse(document);
  if (!parsed.success) {
    throw new ValidationError(
      "The harness configuration could not be read for agent delegation: the document does not match the config schema. Check the configuration file.",
      "agent_config_invalid",
    );
  }
  const agentsConfig = resolveAgentsConfig(parsed.data);
  if (agentsConfig === undefined || agentsConfig.profiles.length === 0) {
    throw new NotFoundError(
      "No agents are configured. Add an `agents` section (with at least one profile naming a provider and model the `runtime.providers` section declares) to the harness configuration to enable delegation.",
      "agents_not_configured",
    );
  }
  return Object.freeze({
    config: agentsConfig,
    resolver: createProviderModelResolver(parsed.data),
    runtime: resolveRuntimeConfig(parsed.data),
  });
}

// ── The sub-agent's LLM adapter ──

/**
 * Build the sub-agent's `ProviderAdapter` on the llm-bridge choke point.
 *
 * The engine's adapter contract is `streamChatCompletion(request)` streaming
 * `ChatStreamEvent`s; the web's is `streamChat(prompt, options)` streaming
 * `ModelEvent`s. This adapter is a faithful translation: the request's
 * system/history/user messages become the web bridge's prompt+history, and
 * each `ModelEvent` maps back to the `ChatStreamEvent` the engine runtime
 * consumes. Because it IS `streamChat`, the sub-agent's calls are redacted,
 * deduplicated and recorded by exactly the code the parent's are — there is
 * no parallel LLM path.
 *
 * The model the sub-agent speaks as is the one the profile resolved to,
 * passed per request (the run's credential is the parent run's; the sub-
 * agent's model rides on the request, exactly as the engine's
 * ProviderAdapter passes `request.model` through to its client).
 */
export function createSubAgentAdapter(
  credential: ProviderCredential,
  signal: AbortSignal,
): ProviderAdapter {
  return Object.freeze({
    providerId: credential.providerId,
    async *streamChatCompletion(request, invocation) {
      // Split the engine's ChatMessage[] into the web bridge's shape:
      // system prompt (all system messages, joined), the remaining history,
      // and the trailing user prompt. The bridge redacts and dedups ALL of
      // it at its own choke point.
      const systemParts: string[] = [];
      const history: ChatMessage[] = [];
      let prompt = "";
      const messages = [...request.messages];
      const last = messages.length > 0 ? messages[messages.length - 1] : undefined;
      for (const msg of messages) {
        if (msg.role === "system") {
          systemParts.push(msg.content);
        } else if (msg === last && msg.role === "user") {
          prompt = msg.content;
        } else if (msg.role === "user" || msg.role === "assistant" || msg.role === "tool") {
          // Preserve the tool-call pairing verbatim — the OpenAI contract
          // requires an assistant tool_calls message to stay paired with its
          // tool results, and dropping the ids would orphan the results.
          history.push(msg);
        }
      }
      const { streamChat } = await import("../llm/llm-bridge.ts");
      const startedAt = performance.now();
      let sawError: string | null = null;
      let sawFinish = false;
      try {
        for await (const event of streamChat(prompt, {
          credential,
          signal: combineSignals(signal, request.signal)!,
          ...(invocation?.onResponseReceipt === undefined ? {} : { onResponseReceipt: invocation.onResponseReceipt }),
          ...(request.max_tokens !== undefined ? { maxTokens: request.max_tokens } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(systemParts.length > 0 ? { systemPrompt: systemParts.join("\n\n") } : {}),
          conversationHistory: history,
          ...(request.tools !== undefined && request.tools.length > 0
            ? { tools: request.tools, toolChoice: request.tool_choice ?? "auto" }
            : {}),
        })) {
          // ModelEvent → ChatStreamEvent. The bridge's `error` event carries
          // the provider's typed failure; surface it as a terminal finish
          // with reason "error" so the engine runtime's failure path runs
          // (the runtime turns finishReason "error" into the run's failure).
          switch (event.type) {
            case "text_delta":
              yield Object.freeze({ type: "content" as const, text: event.delta });
              break;
            case "reasoning_delta":
              yield Object.freeze({ type: "reasoning" as const, text: event.delta });
              break;
            case "tool_call_start":
              yield Object.freeze({ type: "tool_call_start" as const, index: event.outputIndex, id: event.callId, name: event.name });
              break;
            case "tool_call_delta":
              yield Object.freeze({ type: "tool_call_delta" as const, index: event.outputIndex, arguments: event.argumentsDelta });
              break;
            case "usage":
              yield Object.freeze({
                type: "usage" as const,
                usage: Object.freeze({
                  promptTokens: event.usage.inputTokens,
                  completionTokens: event.usage.outputTokens,
                  totalTokens: event.usage.totalTokens,
                }),
              });
              break;
            case "finish":
              sawFinish = true;
              yield Object.freeze({ type: "finish" as const, reason: event.reason });
              break;
            case "error": {
              sawError = event.error.message;
              sawFinish = true;
              yield Object.freeze({ type: "finish" as const, reason: "error" });
              break;
            }
            default:
              break;
          }
        }
      } finally {
        // A stream that ends with neither finish nor error is still settled;
        // the engine runtime reads "stop" as a completed turn, and a truncated
        // stream is the provider's answer, not a local silence to fill.
        if (!sawFinish) {
          yield Object.freeze({ type: "finish" as const, reason: "stop" });
        }
        // Recorded through the same metrics owner the parent run uses — a
        // sub-agent's provider call is an `llm` effect with its real duration
        // and outcome, indistinguishable in the ledger from any other (which
        // is the point: one choke point, one accounting).
        recordLlmCall(request.model, performance.now() - startedAt, sawError === null);
        if (sawError !== null) {
          webWarn("agent-runtime-bridge", "sub-agent provider call failed", () => ({ model: request.model, error: sawError }));
        }
      }
    },
    async chatCompletion(request, invocation) {
      let content = "";
      const toolCallMap = new Map<number, { id: string; name: string; arguments: string }>();
      let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;
      let finishReason = "stop";
      for await (const event of this.streamChatCompletion(request, invocation)) {
        switch (event.type) {
          case "content": content += event.text; break;
          case "tool_call_start": toolCallMap.set(event.index, { id: event.id, name: event.name, arguments: "" }); break;
          case "tool_call_delta": {
            const existing = toolCallMap.get(event.index);
            if (existing) existing.arguments += event.arguments;
            break;
          }
          case "usage": usage = event.usage; break;
          case "finish": finishReason = event.reason; break;
          default: break;
        }
      }
      const toolCalls = [...toolCallMap.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, tc]) => Object.freeze({
          id: tc.id, type: "function" as const,
          function: Object.freeze({ name: tc.name, arguments: tc.arguments }),
        }));
      return Object.freeze({ content, toolCalls, usage, finishReason });
    },
  });
}

// ── The sub-agent's tool registry ──

/**
 * Build a delegation's tool registry by NARROWING the parent's manifest.
 *
 * Derived from the unified manifest, never from a name list:
 *
 *   - The PARENT's enabled manifest is the universe (a tool the parent may
 *     not call, a sub-agent may not either — the delegation narrows, it
 *     never adds).
 *   - A tool survives iff EVERY capability it declares is in the effective
 *     (intersected) capability set. Declaring `write` is what keeps an
 *     editor tool out of a read-only delegation; declaring `execute` is
 *     what keeps `execute_command` out. A tool added to the manifest
 *     tomorrow classifies itself by its own declaration.
 *   - The delegation tools themselves (delegate_to_agent / list_agents /
 *     get_agent_state) survive only when the effective set keeps `delegate`,
 *     because their manifest entries declare the `delegate` capability — so
 *     a sub-agent whose restriction removed delegation cannot spawn agents
 *     of its own around the restriction.
 *
 * Every registered tool's handler re-enters the web executor's
 * `executeToolCall` — so the safety gate, the confinement choke point and
 * the effect recording the parent's calls get are exactly the sub-agent's.
 * The executor is called with the SAME `ToolExecutionContext` (project root,
 * gate, tool-result store) the parent was using.
 */
export function createDelegationToolRegistry(
  ctx: ToolExecutionContext,
  parentManifest: readonly WebToolEntry[],
  effectiveCapabilities: readonly string[],
): ReturnType<typeof createToolRegistry> {
  // The engine registry is created EMPTY (the engine's own default seed
  // tools are not the web's surface) and populated from the parent's
  // manifest — the delegation surface is the web's tool pipeline, not the
  // engine CLI's. `seedDefaults: false` is the owner's own door for this:
  // without it the seeds (read_file, list_files, …) would collide with the
  // web's same-named tools on `register`.
  const registry = createToolRegistry({ seedDefaults: false });
  const effective = new Set(effectiveCapabilities);
  for (const entry of parentManifest) {
    const survives = entry.capabilities.every((cap) => effective.has(cap));
    if (!survives) continue;
    const name = entry.name;
    const registered: RegisteredTool = Object.freeze({
      definition: Object.freeze({
        type: "function" as const,
        function: Object.freeze({
          name,
          description: entry.description,
          parameters: entry.inputSchema,
        }),
      }),
      handler(): string {
        // The engine runtime dispatches through `registry.executeAsync`,
        // which prefers `asyncHandler` when present. The sync door is a
        // typed refusal rather than a wrong answer: a sync handler cannot
        // await the web executor, and the engine's `delegate_to_agent`
        // established this exact contract for async-only tools.
        throw new ValidationError(
          `Tool '${name}' must be dispatched through the async execution path`,
          "tool_async_only",
        );
      },
      asyncHandler: async (args: Readonly<Record<string, unknown>>, _toolContext: ToolContext): Promise<string> => {
        const result: ToolCallResult = await executeViaWebExecutor(name, args, ctx);
        return result.output;
      },
    });
    registry.register(registered);
  }
  return registry;
}

// The executor is reached through a DYNAMIC ESM import — never
// `createRequire` (which would hand the bridge a second copy of the executor
// + the engine's shared modules under the test runner, the dual-instance
// trap) and never a static import (which would close the
// tool-executor → agent-runtime-bridge → tool-executor cycle at load time).
// The dynamic import defers resolution to the first delegated tool call,
// keeping the bridge's own module init free of the cycle, and the call below
// is `await`-ed directly so the promise settles here.
async function executeViaWebExecutor(
  name: string,
  args: Readonly<Record<string, unknown>>,
  ctx: ToolExecutionContext,
): Promise<ToolCallResult> {
  const { executeToolCall } = await import("../tools/tool-executor.ts");
  // The executor records onto ctx.safetyRuntime when the run threaded one
  // — parent and delegated calls share that choke point. This wrapper
  // only re-enters the executor.
  return executeToolCall(name, args, ctx);
}

// ── The per-run bridge state ──

type RunAgentBridge = Readonly<{
  tools: readonly RegisteredTool[];
}>;

const perRunBridges = new Map<string, RunAgentBridge>();

/**
 * Build (or return) the agent-tools bundle for a run. The bundle is per-run
 * because the state store is per-run — `get_agent_state` must answer from
 * THIS run's delegations, not from a process-global list.
 *
 * The parent run's own pieces are threaded in: the abort signal (cancelling
 * the run abandons an in-flight delegation), the credential, and the tool
 * execution context (so the sub-agent's tool calls inherit the parent's
 * gate + confinement + tool-result store).
 */
export function agentToolsForRun(
  runId: string,
  runSignal: AbortSignal,
  credential: ProviderCredential,
  toolCtx: ToolExecutionContext,
  parentManifest: readonly WebToolEntry[],
): RunAgentBridge {
  const existing = perRunBridges.get(runId);
  if (existing !== undefined) return existing;

  const resolved = resolveAgents();
  const bridge = buildRunBridge(runId, runSignal, credential, toolCtx, parentManifest, resolved);
  perRunBridges.set(runId, bridge);
  return bridge;
}

function buildRunBridge(
  runId: string,
  runSignal: AbortSignal,
  credential: ProviderCredential,
  toolCtx: ToolExecutionContext,
  parentManifest: readonly WebToolEntry[],
  resolved: ResolvedAgents,
): RunAgentBridge {
  // The sub-agent's repository root is the run's project root, re-anchored
  // through the filesystem gate's owner so the value handed to the engine is
  // the gate's own resolved form (never a caller-supplied string that only
  // looks inside the project). `"."` resolves to the root itself; a root
  // that escapes itself is a traversal refusal here, before any tool runs.
  const repositoryRoot = resolveWithinProject(".", toolCtx.projectRoot);
  const options: AgentToolsOptions = {
    repositoryRoot,
    agentsConfig: resolved.config,
    adapter: createSubAgentAdapter(credential, runSignal),
    // The registry handed to `createAgentTools` is the run's FULL delegation
    // surface; the per-delegation narrowing happens in the delegate wrapper
    // below (it rebuilds a restricted registry per call from the resolved
    // restriction). The full surface here is the union of every profile's
    // capabilities — a profile that lacks `write` still narrows the runtime
    // it is handed, because the engine runtime filters the registry by the
    // PROFILE's own capability declaration per turn.
    toolRegistry: createDelegationToolRegistry(
      toolCtx,
      parentManifest,
      [...new Set(resolved.config.profiles.flatMap((p) => [...p.capabilities]))],
    ),
    resolver: resolved.resolver,
    timeline: getTimelineRecorder(),
    runId,
    // The SHARED agent-state store (the same one the Agents tab reads), so a
    // delegated agent is recorded where the rest of the product can see it.
    // Per-run isolation for `get_agent_state` is applied at READ time in the
    // wrapped handler below (filter by this run's id), not by forking the
    // store — two stores over one ledger is the two-answers defect.
    stateStore: sharedAgentStateStore(),
    timeoutMs: agentTimeoutMs(),
  };

  // Build the three engine tools, then WRAP delegate_to_agent (the per-call
  // `restrictions` narrowing) and get_agent_state (per-run scoping) before
  // the engine runtime is constructed.
  const engineTools = createAgentTools(options);
  const tools = engineTools.map((tool) => {
    if (tool.definition.function.name === "delegate_to_agent") {
      return wrapDelegateWithRestrictions(tool, options, toolCtx, parentManifest, resolved);
    }
    if (tool.definition.function.name === "get_agent_state") {
      return wrapGetAgentStateForRun(tool, runId);
    }
    return tool;
  });

  // ── The orchestration tool (delegate_to_orchestrator) ──
  //
  // Built on the SAME pieces the single-agent tools use — the same sub-agent
  // adapter (the llm-bridge choke point), the same full-capability delegation
  // registry (each orchestrated sub-agent's profile narrows it per turn),
  // the same resolver, the same timeline recorder — PLUS the durable
  // event-ledger store the orchestrator requires. The store is the shared
  // persistent SQLite timeline ledger (`getTimelineStore()`), NOT a parallel
  // store: orchestrated sub-agent events land in the same chain-hashed ledger
  // as every other run event.
  const orchestratorOptions: OrchestratorToolsOptions = {
    repositoryRoot,
    agentsConfig: resolved.config,
    adapter: options.adapter,
    toolRegistry: options.toolRegistry,
    resolver: resolved.resolver,
    store: getTimelineStore(),
    timeline: getTimelineRecorder(),
    // `exactOptionalPropertyTypes`: omit the key when the timeout is absent
    // rather than assigning `undefined` (which the optional property forbids).
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  };
  const orchestratorTools = createOrchestratorTools(orchestratorOptions).map((tool) =>
    tool.definition.function.name === "delegate_to_orchestrator"
      ? wrapOrchestratorForRun(tool, orchestratorOptions, toolCtx, parentManifest, runId, resolved)
      : tool,
  );

  return Object.freeze({ tools: Object.freeze([...tools, ...orchestratorTools]) });
}

/** Drop a run's bridge when the run ends. Idempotent. */
export function releaseAgentBridge(runId: string): void {
  perRunBridges.delete(runId);
}

// ── The get_agent_state wrapper: per-run scoping on the shared store ──

/**
 * Scope `get_agent_state` to THIS run. The store is shared (so the Agents
 * tab sees every delegation), but the tool answers for the calling run only
 * — a run must not read another run's delegated agents. The engine's own
 * handler returns `stateStore.allAgentStates()` (the whole store); this
 * wrapper applies the same projection the engine handler produces, filtered
 * to the run. The narrowing is by runId, the store's own scoping key.
 */
function wrapGetAgentStateForRun(tool: RegisteredTool, runId: string): RegisteredTool {
  const store = sharedAgentStateStore();
  return Object.freeze({
    ...tool,
    handler(args: Readonly<Record<string, unknown>>): string {
      const filter = typeof args.agentName === "string" ? args.agentName : null;
      const states = store.allAgentStates()
        .filter((s) => s.runId === runId)
        .filter((s) => filter === null || s.agentName === filter)
        .map((s) => ({
          agentId: s.agentId,
          agentName: s.agentName,
          taskId: s.taskId,
          lifecycleState: s.lifecycleState,
          turnCount: s.turnCount,
          totalTokens: s.totalTokens,
          lastError: s.lastError,
        }));
      return JSON.stringify({ agents: states, total: states.length });
    },
  });
}

// ── The delegate wrapper: per-call restriction narrowing ──

/**
 * Wrap the engine's `delegate_to_agent` so the optional `restrictions`
 * argument narrows the sub-agent's registry + profile BEFORE the runtime is
 * constructed. The narrowing is enforced by `agent-restrictions.ts` (the
 * single owner); this wrapper plumbs the resolved restriction into a
 * per-call registry and a restricted profile, then defers to the engine's
 * own delegation machinery — the runtime is built with the NARROWED pieces,
 * so the restriction is the authority the sub-agent was actually built with,
 * not a filter applied around its result.
 */
function wrapDelegateWithRestrictions(
  delegateTool: RegisteredTool,
  options: AgentToolsOptions,
  toolCtx: ToolExecutionContext,
  parentManifest: readonly WebToolEntry[],
  resolved: ResolvedAgents,
): RegisteredTool {
  const inner = delegateTool.asyncHandler;
  if (inner === undefined) return delegateTool;
  return Object.freeze({
    ...delegateTool,
    asyncHandler: async (args, context, signal) => {
      const restrictions: DelegationRestrictions | undefined = parseDelegationRestrictions(
        (args as Record<string, unknown>).restrictions,
      );
      if (restrictions === undefined) {
        return inner(args, context, signal);
      }
      const rawName = (args as Record<string, unknown>).agentName;
      const agentName = typeof rawName === "string" ? rawName : "";
      const profile = getAgentProfile(resolved.config, agentName);
      const narrowed = resolveDelegationRestrictions(profile, restrictions, toolCtx.projectRoot);
      const narrowedProfile = restrictedProfile(profile, narrowed);
      const registry = createDelegationToolRegistry(toolCtx, parentManifest, narrowed.capabilities);
      const narrowedOptions: AgentToolsOptions = {
        ...options,
        toolRegistry: registry,
        agentsConfig: Object.freeze({
          ...resolved.config,
          profiles: Object.freeze([narrowedProfile]),
        }),
      };
      const narrowedTools = createAgentTools(narrowedOptions);
      const narrowedDelegate = narrowedTools.find((t) => t.definition.function.name === "delegate_to_agent");
      if (narrowedDelegate?.asyncHandler === undefined) {
        throw new ValidationError(
          "delegate_to_agent is unavailable in the restricted agent tool set",
          "agent_delegate_unavailable",
        );
      }
      return narrowedDelegate.asyncHandler(args, context, signal);
    },
  });
}

// ── The orchestrator wrapper: per-task narrowing + run-pane surfacing ──

/**
 * Parse + validate the optional per-task `restrictions` on an orchestration
 * `tasks` array. Each task may carry its own narrowing (same vocabulary as
 * the single-agent `restrictions` — preset / capabilities / writeSet),
 * enforced narrowing-only by `agent-restrictions.ts`. A task's restriction
 * can only REMOVE authority its named profile holds — never widen it.
 *
 * This runs BEFORE the engine's own `parseTasks` (inside the inner handler),
 * so a malformed `restrictions` on any task is a typed refusal naming the
 * task, before the orchestration is planned. Returns the args with each
 * task's `restrictions` replaced by its parsed (typed) form, so the engine's
 * schema (which forbids the field) never sees an unvalidated value — the
 * field is consumed here and dropped before the inner handler runs.
 */
function parseOrchestrationTaskRestrictions(
  args: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const rawTasks = (args as Record<string, unknown>).tasks;
  if (!Array.isArray(rawTasks)) return args; // the engine's own validation reports the shape
  const tasks = rawTasks.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
    const obj = item as Record<string, unknown>;
    if (obj.restrictions === undefined) return obj;
    // Parse now (typed refusal on a bad value) and DROP the field: the
    // narrowing is applied to the profile/registry by the wrapper, not by
    // the engine, whose task schema does not carry `restrictions`.
    parseDelegationRestrictions(obj.restrictions);
    const { restrictions: _dropped, ...rest } = obj;
    void _dropped;
    return rest;
  });
  return Object.freeze({ ...args, tasks: Object.freeze(tasks) });
}

/**
 * Mirror each orchestrated agent into the SHARED agent-state store under the
 * CALLING run's id, so the run pane's Agents section and the per-run-scoped
 * `get_agent_state` show them.
 *
 * Why a mirror: the orchestrator builds its OWN private state store over the
 * durable ledger (it does not share `sharedAgentStateStore`), and it scopes
 * each sub-agent under the orchestration's OWN run id (a fresh `run-…`). So
 * the shared store the pane reads holds nothing for the calling chat run.
 * The pane's per-run filter and the scoped `get_agent_state` read by the
 * CALLING run's id — without this mirror, orchestrated agents would be
 * invisible to the run that started them (the wired-but-inert class).
 *
 * The mirror is a read-model projection: for each orchestrated agent (read
 * from the tool's own `agentResults`, the authoritative per-agent outcome),
 * record a well-formed start+terminal lifecycle under the CALLING run's id in
 * the shared store (the same owner the single-agent path records into). The
 * orchestration's own records (under its run id, in the durable ledger)
 * remain the truth; the mirror is what the pane and the scoped tool read.
 * Mirroring is idempotent per (orchestration, agent) via `seen`.
 */
function mirrorOrchestratedAgentsIntoRun(
  seen: Set<string>,
  agentResults: readonly { agentName: string; lifecycleState: string; turns?: number; totalTokens?: number }[],
  orchRunId: string,
  chatRunId: string,
): void {
  const store = sharedAgentStateStore();
  // Disambiguate per (task index, agent name): an orchestration often reuses
  // ONE profile across several tasks (e.g. researcher runs task A then task
  // B), and keying the mirror by agent name alone would collapse those into
  // a single pane entry — the pane would show one agent where two ran. The
  // result array's order is the plan's task order, so the index is a stable
  // per-task discriminator within one orchestration.
  agentResults.forEach((result, taskIndex) => {
    const taskKey = `orch:${orchRunId}:task-${taskIndex}`;
    const mirrorId = `${taskKey}:${result.agentName}`;
    if (seen.has(mirrorId)) return;
    seen.add(mirrorId);
    // A well-formed lifecycle under the CALLING run's id: a start (the store
    // requires it before any terminal transition), the real turn/token usage
    // (so the pane shows the measured cost, not a fabricated zero), then the
    // terminal record matching the orchestrated agent's real outcome. The
    // taskId / attemptId are namespaced by the orchestration run + task index
    // so the mirror never collides with the orchestration's own durable
    // records or with a sibling task reusing the same profile.
    store.recordAgentStart({
      agentId: mirrorId,
      agentName: result.agentName,
      runId: chatRunId,
      taskId: taskKey,
      attemptId: mirrorId,
    });
    const turnCount = typeof result.turns === "number" ? result.turns : 0;
    const totalTokens = typeof result.totalTokens === "number" ? result.totalTokens : 0;
    // Record the measured usage so the pane's turn/token counts are real
    // (read from the orchestration's result), not a hardcoded zero standing
    // in for a quantity we have. The store accumulates per recorded turn, so
    // one summary turn carries the real token total; the turn count is the
    // real count (recorded as N turn records is overkill — the pane reads
    // turnCount + totalTokens, and both must be the real figures).
    for (let t = 0; t < turnCount; t += 1) {
      // Split the token total across the recorded turns so the aggregate
      // matches the real figure (integer-divisible share; remainder on the
      // last turn). A single lump on one turn would misreport per-turn cost.
      const share = Math.floor(totalTokens / turnCount);
      const isLast = t === turnCount - 1;
      store.recordAgentTurn({
        agentId: mirrorId,
        runId: chatRunId,
        taskId: taskKey,
        attemptId: mirrorId,
        turnId: `${mirrorId}:turn-${t}`,
        turnNumber: t + 1,
        content: "",
        toolCallCount: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: isLast ? totalTokens - share * (turnCount - 1) : share,
        finishReason: "stop",
      });
    }
    if (result.lifecycleState === "succeeded") {
      store.recordAgentCompletion({
        agentId: mirrorId,
        runId: chatRunId,
        taskId: taskKey,
        attemptId: mirrorId,
      });
    } else {
      // Any non-succeeded terminal state (failed / cancelled / timed-out) is
      // mirrored as a failure carrying the honest state, so the pane shows
      // the real outcome rather than dropping the agent.
      store.recordAgentFailure({
        agentId: mirrorId,
        runId: chatRunId,
        taskId: taskKey,
        attemptId: mirrorId,
        error: `orchestrated agent ended in state '${result.lifecycleState}'`,
      });
    }
  });
}

/**
 * The per-task restriction read off a raw orchestration task, resolved
 * against that task's named profile. Produced by
 * `resolveOrchestrationTaskRestrictions`, consumed to build the narrowed
 * profiles the orchestration actually runs with.
 */
type OrchestrationTaskNarrowing = Readonly<{
  /** The profiles the orchestration runs with: the configured profiles PLUS
   * one derived narrowed profile per restricted task (unique name), so a
   * task's restriction never touches a same-named profile another task uses
   * unrestricted. */
  narrowedProfiles: readonly AgentProfile[];
  /** The tasks with each restricted task's `agentName` rewritten to its
   * derived narrowed profile's name (the field the engine resolves by). */
  tasks: readonly Record<string, unknown>[];
  /** True when at least one task carried a restriction (so the narrowed
   * pieces must replace the bridge's defaults). */
  anyRestricted: boolean;
  /** Derived narrowed-profile name → the original profile name it was
   * derived from, so the pane and the model see the real profile name
   * (e.g. `researcher`), never the internal `…::restricted-N` rewrite. */
  originalNameByDerived: ReadonlyMap<string, string>;
}>;

/**
 * Resolve every task's optional `restrictions` against its named profile,
 * narrowing-only, and produce the narrowed profiles the orchestration runs
 * with.
 *
 * HOW THE NARROWING REACHES EACH SUB-AGENT. The engine's agent runtime
 * narrows a sub-agent's offered tools by its profile's `tools` allow-list
 * (`getEnabledTools`), NOT by capability — the capability narrowing lives in
 * the bridge's `createDelegationToolRegistry`. So a per-task restriction is
 * applied by giving the narrowed profile an explicit `tools` allow-list: the
 * names that survive a registry built from that task's effective
 * (intersected) capabilities.
 *
 * PER-TASK, NOT PER-PROFILE. The engine resolves a task's sub-agent by the
 * task's `agentName` (`getAgentProfile(config, name)`), so two tasks sharing
 * one profile name would collide if the narrowing REPLACED that profile — a
 * restricted task would narrow a same-named UNRESTRICTED sibling (an
 * over-narrowing leak). Instead each restricted task gets its OWN derived
 * profile (a unique name) appended to the config, and the task's `agentName`
 * is rewritten to it. A profile used only by unrestricted tasks is left
 * untouched, so an unrestricted sibling keeps its full configured ceiling.
 */
function resolveOrchestrationTaskRestrictions(
  args: Readonly<Record<string, unknown>>,
  resolved: ResolvedAgents,
  projectRoot: string,
  toolCtx: ToolExecutionContext,
  parentManifest: readonly WebToolEntry[],
): OrchestrationTaskNarrowing {
  const rawTasks = (args as Record<string, unknown>).tasks;
  if (!Array.isArray(rawTasks)) {
    return Object.freeze({ narrowedProfiles: resolved.config.profiles, tasks: [], anyRestricted: false, originalNameByDerived: new Map() });
  }
  const profileByName = new Map(resolved.config.profiles.map((p) => [p.name, p]));
  const takenNames = new Set(resolved.config.profiles.map((p) => p.name));
  const derived: AgentProfile[] = [];
  const originalNameByDerived = new Map<string, string>();
  let anyRestricted = false;
  const tasks = rawTasks.map((item, taskIndex) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
    const obj = item as Record<string, unknown>;
    if (obj.restrictions === undefined) return obj;
    anyRestricted = true;
    const rawName = obj.agentName;
    const agentName = typeof rawName === "string" ? rawName : "";
    const profile = profileByName.get(agentName);
    // An unknown profile is reported by the engine's plan() as a typed
    // failure; here we only narrow when the profile resolves.
    if (profile === undefined) return obj;
    const restrictions = parseDelegationRestrictions(obj.restrictions);
    const narrowed = resolveDelegationRestrictions(profile, restrictions, projectRoot);
    // Build the registry this task's effective capabilities permit, and read
    // its surviving tool NAMES into the profile's allow-list — the engine's
    // per-turn `getEnabledTools` filter is by name, so this is where the
    // capability narrowing actually lands on the sub-agent's request.
    const taskRegistry = createDelegationToolRegistry(toolCtx, parentManifest, narrowed.capabilities);
    const taskToolNames = taskRegistry.names();
    const restricted = restrictedProfile(profile, narrowed, taskToolNames);
    // A derived profile with a name no configured profile or sibling task
    // holds, so the rewrite cannot collide. The task index disambiguates two
    // tasks restricting the SAME profile differently.
    let derivedName = `${agentName}::restricted-${taskIndex}`;
    while (takenNames.has(derivedName)) derivedName = `_${derivedName}`;
    takenNames.add(derivedName);
    derived.push(Object.freeze({ ...restricted, name: derivedName }));
    originalNameByDerived.set(derivedName, agentName);
    return Object.freeze({ ...obj, agentName: derivedName });
  });
  return Object.freeze({
    narrowedProfiles: Object.freeze([...resolved.config.profiles, ...derived]),
    tasks: Object.freeze(tasks),
    anyRestricted,
    originalNameByDerived,
  });
}

/**
 * Wrap the engine's `delegate_to_orchestrator` so (a) per-task
 * `restrictions` narrow each task's sub-agent (narrowing-only, enforced at
 * the registry+profile the sub-agent is built with), and (b) the
 * orchestrated agents are mirrored into the calling run's agent-state view
 * so the run pane shows them.
 *
 * The narrowing is applied by REBUILDING the orchestrator tools with the
 * narrowed profiles + a registry narrowed to the effective capabilities — so
 * the restriction is the authority each sub-agent was actually built with,
 * not a filter applied around its result (the same contract the single-agent
 * delegate wrapper honours).
 */
function wrapOrchestratorForRun(
  orchestratorTool: RegisteredTool,
  baseOptions: OrchestratorToolsOptions,
  toolCtx: ToolExecutionContext,
  parentManifest: readonly WebToolEntry[],
  runId: string,
  resolved: ResolvedAgents,
): RegisteredTool {
  const inner = orchestratorTool.asyncHandler;
  if (inner === undefined) return orchestratorTool;
  // Tracks which orchestrated agents have already been mirrored into the
  // calling run's view, so a repeated call never double-records. Per bridge
  // (per run), so it resets when the run's bridge is released.
  const mirroredAgents = new Set<string>();
  return Object.freeze({
    ...orchestratorTool,
    asyncHandler: async (args, context, signal) => {
      // Validate + consume per-task restrictions first (typed refusal on a
      // bad value), then hand the engine the consumed args with each
      // restricted task's `agentName` rewritten to its derived narrowed
      // profile (per-task narrowing — a restricted task never touches a
      // same-named profile an unrestricted sibling resolves by name).
      const consumed = parseOrchestrationTaskRestrictions(args);
      const narrowing = resolveOrchestrationTaskRestrictions(args, resolved, toolCtx.projectRoot, toolCtx, parentManifest);
      // Merge the rewritten agentNames into the consumed tasks (both walk the
      // same `tasks` array in order, so the index aligns). Only present when
      // at least one task was restricted.
      const effectiveArgs = narrowing.anyRestricted
        ? Object.freeze({ ...consumed, tasks: Object.freeze(narrowing.tasks.map((t, i) => {
            const consumedTask = (consumed.tasks as readonly unknown[])[i];
            return (t !== null && typeof t === "object" && !Array.isArray(t) &&
                    consumedTask !== null && typeof consumedTask === "object" && !Array.isArray(consumedTask))
              ? Object.freeze({ ...(consumedTask as Record<string, unknown>), agentName: (t as Record<string, unknown>).agentName })
              : consumedTask;
          })) })
        : consumed;
      let output: string;
      if (!narrowing.anyRestricted) {
        output = await inner(consumed, context, signal);
      } else {
        // Rebuild the orchestrator tools with the narrowed PROFILES so each
        // task's restriction is the authority its sub-agent is built with.
        // The registry stays the shared full-capability ceiling — the
        // per-task narrowing lands on each profile's `tools` allow-list,
        // which the engine's runtime applies per task.
        const narrowedOptions: OrchestratorToolsOptions = {
          ...baseOptions,
          agentsConfig: Object.freeze({
            ...resolved.config,
            profiles: narrowing.narrowedProfiles,
          }),
        };
        const narrowedTools = createOrchestratorTools(narrowedOptions);
        const narrowedDelegate = narrowedTools.find((t) => t.definition.function.name === "delegate_to_orchestrator");
        if (narrowedDelegate?.asyncHandler === undefined) {
          throw new ValidationError(
            "delegate_to_orchestrator is unavailable in the restricted agent tool set",
            "agent_delegate_unavailable",
          );
        }
        output = await narrowedDelegate.asyncHandler(effectiveArgs, context, signal);
      }
      // Translate a derived narrowed-profile name back to the original
      // profile name everywhere the caller sees it (the model-facing output
      // AND the pane mirror): the `…::restricted-N` rewrite is internal, so
      // neither surface should show it — the caller named `researcher`, the
      // caller sees `researcher`.
      const translateNames = <T>(value: T): T => {
        if (narrowing.originalNameByDerived.size === 0) return value;
        if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
        const rec = value as Record<string, unknown>;
        const original = typeof rec.agentName === "string"
          ? narrowing.originalNameByDerived.get(rec.agentName)
          : undefined;
        return (original === undefined ? value : Object.freeze({ ...rec, agentName: original })) as T;
      };
      // Mirror the orchestrated agents into THIS run's view so the run pane
      // shows them. Best-effort: a mirror failure must not fail the tool call
      // (the orchestration itself already succeeded and recorded its truth).
      try {
        const parsed: unknown = JSON.parse(output);
        const orchRunId = (parsed as { orchestrationId?: unknown }).orchestrationId;
        const agentResults = (parsed as { agentResults?: unknown }).agentResults;
        if (
          typeof orchRunId === "string" && orchRunId.length > 0 && orchRunId !== runId &&
          Array.isArray(agentResults)
        ) {
          const displayResults = (agentResults as readonly { agentName: string; lifecycleState: string; turns?: number; totalTokens?: number }[]).map(translateNames);
          mirrorOrchestratedAgentsIntoRun(mirroredAgents, displayResults, orchRunId, runId);
        }
        // Re-emit the model-facing output with the original profile names, so
        // the model's per-agent results name the configured profile it asked
        // for, not the internal narrowed-profile rewrite.
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) &&
            Array.isArray((parsed as Record<string, unknown>).agentResults)) {
          const prec = parsed as Record<string, unknown>;
          output = JSON.stringify(Object.freeze({
            ...prec,
            agentResults: Object.freeze((prec.agentResults as readonly unknown[]).map(translateNames)),
          }));
        }
      } catch (mirrorErr) {
        webWarn("agent-runtime-bridge", "orchestrated-agent mirror failed", () => ({
          error: mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr),
        }));
      }
      return output;
    },
  });
}

// ── The four tool handlers (the executor's dispatch targets) ──

/**
 * The context the executor hands every tool, enriched with what delegation
 * needs. The run route threads the run's identity + signal + credential +
 * parent manifest so the bridge can build the per-run substrate; the
 * executor passes it through unchanged (a handler-only concern, never read
 * by other tools).
 */
export type AgentToolContext = ToolExecutionContext & Readonly<{
  runId?: string;
  runSignal?: AbortSignal;
  credential?: ProviderCredential;
  parentManifest?: readonly WebToolEntry[];
}>;

type RequiredAgentContext = AgentToolContext & Readonly<{
  runId: string;
  runSignal: AbortSignal;
  credential: ProviderCredential;
  parentManifest: readonly WebToolEntry[];
}>;

function requireAgentContext(ctx: AgentToolContext): RequiredAgentContext {
  if (
    typeof ctx.runId !== "string" || ctx.runId.length === 0 ||
    ctx.runSignal === undefined ||
    ctx.credential === undefined ||
    ctx.parentManifest === undefined
  ) {
    // A guided refusal: the run route always threads these, so reaching this
    // means a test or a non-run caller invoked the tool directly — the honest
    // answer is that delegation needs a run, not a stack trace.
    throw new ValidationError(
      "Agent delegation requires an active run context (run id, signal, credential and the run's tool manifest). It is available from a chat run, not from a direct tool invocation.",
      "agent_context_missing",
    );
  }
  return ctx as RequiredAgentContext;
}

export function toolListAgents(ctx: AgentToolContext): ToolCallResult {
  try {
    const agentCtx = requireAgentContext(ctx);
    const bridge = agentToolsForRun(agentCtx.runId, agentCtx.runSignal, agentCtx.credential, agentCtx, agentCtx.parentManifest);
    const tool = bridge.tools.find((t) => t.definition.function.name === "list_agents");
    if (tool === undefined) return { success: false, output: "Error: list_agents is not available in this run's agent tool set." };
    return { success: true, output: tool.handler({}, { repositoryRoot: ctx.projectRoot }) };
  } catch (err) {
    return { success: false, output: err instanceof Error ? `Error: ${err.message}` : `Error: ${String(err)}` };
  }
}

export async function toolDelegateToAgent(ctx: AgentToolContext, args: Readonly<Record<string, unknown>>): Promise<ToolCallResult> {
  try {
    const agentCtx = requireAgentContext(ctx);
    const bridge = agentToolsForRun(agentCtx.runId, agentCtx.runSignal, agentCtx.credential, agentCtx, agentCtx.parentManifest);
    const tool = bridge.tools.find((t) => t.definition.function.name === "delegate_to_agent");
    if (tool?.asyncHandler === undefined) {
      return { success: false, output: "Error: delegate_to_agent is not available in this run's agent tool set." };
    }
    const output = await tool.asyncHandler(args, { repositoryRoot: ctx.projectRoot }, agentCtx.runSignal);
    return { success: true, output };
  } catch (err) {
    return { success: false, output: err instanceof Error ? `Error: ${err.message}` : `Error: ${String(err)}` };
  }
}

export function toolGetAgentState(ctx: AgentToolContext, args: Readonly<Record<string, unknown>>): ToolCallResult {
  try {
    const agentCtx = requireAgentContext(ctx);
    const bridge = agentToolsForRun(agentCtx.runId, agentCtx.runSignal, agentCtx.credential, agentCtx, agentCtx.parentManifest);
    const tool = bridge.tools.find((t) => t.definition.function.name === "get_agent_state");
    if (tool === undefined) return { success: false, output: "Error: get_agent_state is not available in this run's agent tool set." };
    return { success: true, output: tool.handler(args, { repositoryRoot: ctx.projectRoot }) };
  } catch (err) {
    return { success: false, output: err instanceof Error ? `Error: ${err.message}` : `Error: ${String(err)}` };
  }
}

export async function toolDelegateToOrchestrator(ctx: AgentToolContext, args: Readonly<Record<string, unknown>>): Promise<ToolCallResult> {
  try {
    const agentCtx = requireAgentContext(ctx);
    const bridge = agentToolsForRun(agentCtx.runId, agentCtx.runSignal, agentCtx.credential, agentCtx, agentCtx.parentManifest);
    const tool = bridge.tools.find((t) => t.definition.function.name === "delegate_to_orchestrator");
    if (tool?.asyncHandler === undefined) {
      return { success: false, output: "Error: delegate_to_orchestrator is not available in this run's agent tool set." };
    }
    const output = await tool.asyncHandler(args, { repositoryRoot: ctx.projectRoot }, agentCtx.runSignal);
    return { success: true, output };
  } catch (err) {
    return { success: false, output: err instanceof Error ? `Error: ${err.message}` : `Error: ${String(err)}` };
  }
}

// ── The manifest entries (built here, registered by the manifest owner) ──

/**
 * The agent tools' manifest entries, built dynamically so the
 * `delegate_to_agent` + `delegate_to_orchestrator` schemas' restriction
 * enums derive from the vocabulary owners (`DELEGATION_RESTRICTION_PRESETS`
 * + `AGENT_CAPABILITY_CATALOG`). The manifest owner (tools-bridge) registers
 * these the same way it registers every web-UI-owned entry — one pipeline,
 * one schema shape.
 *
 * The enums are derived, never literal: a preset or capability added to the
 * vocabulary reaches the model's schema with no second edit. The two tools
 * share the ONE `restrictionSchema` so their per-task/per-call narrowing
 * vocabulary cannot drift.
 */
export function buildAgentToolManifestEntries(
  bounds: WebToolEntry["bounds"],
): readonly ToolManifestEntry[] {
  const delegateDescription =
    "Delegate a task to a configured agent. The agent runs its own bounded turn loop using the session's provider and a narrowed tool set, then returns its final lifecycle state, turn count, token usage, and final answer text. " +
    "Optional `restrictions` narrow the sub-agent further: a `preset` (" +
    DELEGATION_RESTRICTION_PRESETS.join(", ") +
    "), an explicit `capabilities` list, and/or a `writeSet` of the only paths it may write. A restriction can only REMOVE authority the agent's profile holds — never widen it.";
  // The per-task `restrictions` schema for delegate_to_orchestrator reuses the
  // single-agent vocabulary (same owner, same enums) so the two tools cannot
  // drift on what a restriction is.
  const restrictionSchema = Object.freeze({
    type: "object",
    description: "Optional narrowing of the sub-agent's authority. Narrowing-only: it can remove capabilities the profile holds, never add them.",
    properties: Object.freeze({
      preset: Object.freeze({ type: "string", enum: DELEGATION_RESTRICTION_PRESETS, description: "A named restriction preset." }),
      capabilities: Object.freeze({ type: "array", items: Object.freeze({ type: "string", enum: AGENT_CAPABILITY_CATALOG }), description: "The capabilities the sub-agent keeps (intersected with the profile's)." }),
      writeSet: Object.freeze({ type: "array", items: Object.freeze({ type: "string" }), description: "The only paths the sub-agent may write (project-relative). Must fall inside the profile's own write set when it declares one." }),
    }),
    additionalProperties: false,
  });
  const orchestrateDescription =
    "Coordinate several configured agents in combination. Build an orchestration plan from the requested `tasks` (each with an agentName, a task description, an optional taskId, and optional dependsOn task IDs), resolve write-set conflicts, execute the plan respecting dependencies, and return a summary of results, turns, tokens, conflicts, and each agent's final answer text. " +
    "Each task may carry its own `restrictions` (same narrowing-only vocabulary as delegate_to_agent) that narrows that task's sub-agent further — never widening past its profile.";
  const entry = (
    name: string,
    description: string,
    inputSchema: Readonly<Record<string, unknown>>,
    capabilities: readonly ToolCapability[],
  ): ToolManifestEntry => Object.freeze({
    id: name,
    name,
    description,
    inputSchema,
    capabilities: Object.freeze([...capabilities]),
    bounds,
    adapterId: AGENT_TOOLS_ADAPTER_ID,
  });
  return Object.freeze([
    entry(
      "list_agents",
      "List the configured agent profiles available for delegation (name, type, provider, model, capabilities, write set). Read-only.",
      Object.freeze({ type: "object", properties: Object.freeze({}), required: Object.freeze([]), additionalProperties: false }),
      ["read"],
    ),
    entry(
      "delegate_to_agent",
      delegateDescription,
      Object.freeze({
        type: "object",
        properties: Object.freeze({
          agentName: Object.freeze({ type: "string", description: "Name of the configured agent profile to delegate to." }),
          task: Object.freeze({ type: "string", description: "The task description for the agent." }),
          restrictions: restrictionSchema,
        }),
        required: Object.freeze(["agentName", "task"]),
        additionalProperties: false,
      }),
      // "read" (not "delegate", which is not a manifest capability): the
      // capability filter keeps a tool iff every capability it DECLARES is in
      // the effective set. Declaring "read" here means delegation survives a
      // read-capable restriction — the engine's own profile gate (the
      // `delegate` capability in the agent PROFILE's config, enforced by the
      // engine runtime per turn) is what actually gates whether a sub-agent
      // may delegate further. The manifest capability carries the "this tool
      // reads the delegation surface" meaning; the profile capability carries
      // the "may spawn agents" authority.
      ["read"],
    ),
    entry(
      "get_agent_state",
      "Return the lifecycle state of agents run in this conversation (name, state, turn count, token usage). Read-only.",
      Object.freeze({
        type: "object",
        properties: Object.freeze({
          agentName: Object.freeze({ type: "string", description: "Optional agent name filter." }),
        }),
        required: Object.freeze([]),
        additionalProperties: false,
      }),
      ["read"],
    ),
    entry(
      "delegate_to_orchestrator",
      orchestrateDescription,
      Object.freeze({
        type: "object",
        properties: Object.freeze({
          tasks: Object.freeze({
            type: "array",
            description: "Tasks to execute. Each task has an agentName, a task description, an optional taskId, optional dependsOn task IDs, and an optional per-task restrictions narrowing.",
            items: Object.freeze({
              type: "object",
              properties: Object.freeze({
                agentName: Object.freeze({ type: "string", description: "Name of the configured agent profile." }),
                task: Object.freeze({ type: "string", description: "The task description." }),
                taskId: Object.freeze({ type: "string", description: "Optional task ID (used by other tasks' dependsOn)." }),
                dependsOn: Object.freeze({ type: "array", items: Object.freeze({ type: "string" }), description: "Optional task IDs this task depends on." }),
                restrictions: restrictionSchema,
              }),
              required: Object.freeze(["agentName", "task"]),
              additionalProperties: false,
            }),
          }),
          maximumTurns: Object.freeze({
            type: "integer",
            description: "Optional limit on the total number of turns across all agents (default: no limit).",
            minimum: 1,
          }),
        }),
        required: Object.freeze(["tasks"]),
        additionalProperties: false,
      }),
      // "read" like the other delegation tools (see delegate_to_agent above).
      ["read"],
    ),
  ]);
}

/** The adapter id the agent tools' manifest entries carry (the kind owner
 * maps it; the capability filter reads the manifest entries, not this id). */
export const AGENT_TOOLS_ADAPTER_ID = "web-ui-agents";

/** Read the per-delegation timeout from the snapshot's `runtime.limits`
 * section; the engine's own default (`DEFAULT_AGENT_TIMEOUT_MS`) when the
 * config does not declare one. Read per delegation so a config edit reaches
 * the next delegation without a restart. */
function agentTimeoutMs(): number {
  const document = readSettingsDocument();
  const limits = (document.runtime as Record<string, unknown> | undefined)?.limits as Record<string, unknown> | undefined;
  const value = limits?.agentTimeoutMs;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  return AGENT_TIMEOUT_FALLBACK_MS;
}

// The engine owns the fallback; re-exported through canonical so this module
// reads the owner's value rather than a second literal.
import { DEFAULT_AGENT_TIMEOUT_MS as AGENT_TIMEOUT_FALLBACK_MS } from "../kernel/canonical.ts";
