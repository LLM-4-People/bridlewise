import { extractErrorMessage, HarnessError, InputError } from "../kernel/errors.ts";
import { bestEffort } from "../shared/best-effort.ts";
import { deepFreeze, generateShortId, sha256 } from "../kernel/integrity.ts";
import { DEFAULT_EVALUATION_MAX_OUTPUT_TOKENS } from "../kernel/config-contracts.ts";
import {
  createProviderAdapter,
  type ChatCompletionResult,
  type ChatMessage,
  type ProviderAdapter,
  type ProviderAdapterOptions,
  type TokenUsage,
  type ToolCall,
} from "../runtime/provider-adapter.ts";
import type { TimelineRecorder } from "../timeline/timeline-recorder.ts";
import { extractResponseHeaders } from "../shared/llm/client.ts";
import { resolveResponsesTransportConfig } from "../shared/llm/config.ts";
import { parseProviderJson, PROVIDER_LOG_CATEGORY } from "../shared/llm/provider-http.ts";
import { discardBody, outboundFetch, readBody } from "../shared/outbound-http.ts";
import { OPERATOR_OWNER, privateAddressesAllowedFor } from "../shared/outbound-policy.ts";
import { deadline } from "../shared/abort-signals.ts";
import type {
  CapabilityProbe,
  CellExecutionRequest,
  CellResult,
  CellRunResult,
  CellTopologyMeta,
  ChepArtifact,
  ChepModelId,
  HiddenOracle,
  MatrixDocument,
  OracleCheckResult,
  ScenarioRecord,
  TopologyRecord,
} from "./types.ts";

/**
 * CHEP-1.0 scenario runner — executes a single evaluation cell.
 *
 * For each run in a cell:
 * 1. Attest the Makora identity (endpoint, model ID, temperature).
 * 2. Send the scenario prompt to the provider via the adapter.
 * 3. Record everything to the timeline (run, turn, messages, tokens, etc.).
 * 4. Capture the model's response.
 * 5. Run deterministic hidden oracles against the response.
 *
 * Supports a "minimal reference transport" mode that sends the same prompt
 * via a minimal raw fetch call (no harness machinery) to quantify
 * harness-induced effects.
 *
 * The runner respects budgets (token limits, time limits) and fails
 * if identity can't be established.
 */

export type ScenarioRunnerOptions = Readonly<{
  adapter?: ProviderAdapter;
  timeline?: TimelineRecorder;
  signal?: AbortSignal;
  maxRuns?: number;
  /** MAJ-4: called after each run completes; if it returns true the runner stops. */
  budgetExceeded?: () => boolean;
  /** MAJ-3: called after each run completes with the run's result and tokens. */
  onRunComplete?: (result: CellRunResult) => void;
  /** B7: identity attestation timeout from config (default 30s). */
  identityAttestationTimeoutMs?: number;
}>;

import { IDENTITY_ATTESTATION_TIMEOUT_MS } from "./evaluation-config.ts";
import { handleError } from "../shared/debug/debug-system.ts";
const PROBE_PROMPT = "Reply with exactly: IDENTITY_PROBE_OK";
const IDENTITY_PROBE_MARKER = "IDENTITY_PROBE_OK";

export function createScenarioRunner(options: ScenarioRunnerOptions = {}): ScenarioRunner {
  return deepFreeze({
    runCell: async (request: CellExecutionRequest, runOptions?: ScenarioRunnerOptions) =>
      runCellInternal(request, { ...options, ...(runOptions ?? {}) }),
  });
}

export type ScenarioRunner = Readonly<{
  runCell(request: CellExecutionRequest, options?: ScenarioRunnerOptions): Promise<CellResult>;
}>;

async function runCellInternal(
  request: CellExecutionRequest,
  options: ScenarioRunnerOptions,
): Promise<CellResult> {
  const cell = request.matrix.cells.find((c) => c.cell_id === request.cellId);
  if (cell === undefined) {
    const fallbackModel = request.matrix.models[0] ?? "";
    return deepFreeze(makeErrorResult(request.cellId, fallbackModel, `Cell ${request.cellId} not found in matrix`));
  }

  const adapter = options.adapter ?? buildAdapterFromRequest(request);
  const timeline = options.timeline;
  const signal = options.signal ?? request.signal;
  const identityAttestationTimeoutMs = options.identityAttestationTimeoutMs ?? IDENTITY_ATTESTATION_TIMEOUT_MS;
  const runsToExecute = options.maxRuns !== undefined && options.maxRuns >= 0
    ? cell.runs.slice(0, Math.min(options.maxRuns, cell.runs.length))
    : cell.runs;
  const runs: CellRunResult[] = [];

  for (const run of runsToExecute) {
    try {
      const runResult = await executeRun(request, cell, run, adapter, signal, timeline, run.replicate, identityAttestationTimeoutMs);
      runs.push(runResult);
      // MAJ-3: report each run's completion (and tokens) immediately so a
      // crash mid-cell does not lose that run's token spend.
      if (options.onRunComplete !== undefined) options.onRunComplete(runResult);
    } catch (error) {
      const message = extractErrorMessage(error);
      const errorResult = deepFreeze({
        runId: run.run_id,
        replicate: run.replicate,
        content: "",
        usage: undefined,
        finishReason: "error",
        durationMs: 0,
        temperature: 0 as const,
        error: message,
        modelRevision: deepFreeze({
          requestedModelId: cell.model_id,
          returnedModelId: null,
          mappingStatus: "not-returned" as const,
          providerRequestId: null,
          providerDate: null,
        }),
        isReference: false,
        oracleResults: deepFreeze([]),
      });
      runs.push(errorResult);
      if (options.onRunComplete !== undefined) options.onRunComplete(errorResult);
    }
    // MAJ-4: enforce the budget after EACH run, not just after each cell. If
    // the budget is exceeded mid-cell, stop after the current run and record
    // the remaining planned replicates as skipped (not silently dropped).
    if (options.budgetExceeded !== undefined && options.budgetExceeded()) {
      for (let i = runs.length; i < runsToExecute.length; i++) {
        const skippedRun = runsToExecute[i]!;
        runs.push(deepFreeze({
          runId: skippedRun.run_id,
          replicate: skippedRun.replicate,
          content: "",
          usage: undefined,
          finishReason: "skipped-budget-exceeded",
          durationMs: 0,
          temperature: 0 as const,
          error: null,
          modelRevision: deepFreeze({
            requestedModelId: cell.model_id,
            returnedModelId: null,
            mappingStatus: "not-returned" as const,
            providerRequestId: null,
            providerDate: null,
          }),
          isReference: false,
          oracleResults: deepFreeze([]),
        }));
      }
      break;
    }
  }

  const allOraclesPassed = runs.length > 0 && runs.every((r) =>
    r.oracleResults.length > 0 && r.oracleResults.every((o) => o.passed)
  );
  const identityAttested = runs.every((r) =>
    r.modelRevision.mappingStatus === "exact" ||
    r.modelRevision.mappingStatus === "exact-body" ||
    r.modelRevision.mappingStatus === "preregistered-provider-alias"
  );

  return deepFreeze({
    cellId: cell.cell_id,
    modelId: cell.model_id,
    runs: deepFreeze(runs),
    allOraclesPassed,
    identityAttested,
    error: null,
  });
}

function buildAdapterFromRequest(request: CellExecutionRequest): ProviderAdapter {
  if (!request.apiKey || request.apiKey.length === 0) {
    throw new InputError("API key is missing — cannot create provider adapter without a key", "evaluation_api_key_missing");
  }
  const opts: ProviderAdapterOptions = {
    provider: {
      id: request.providerConfig.id,
      baseUrl: request.providerConfig.baseUrl,
      timeoutMs: request.providerConfig.timeoutMs,
      retries: request.providerConfig.retries,
      ...(request.providerConfig.responses !== undefined ? { responses: request.providerConfig.responses } : {}),
      ...(request.providerConfig.chatCompletionsPath !== undefined
        ? { chatCompletionsPath: request.providerConfig.chatCompletionsPath }
        : {}),
    },
    apiKey: request.apiKey,
  };
  return createProviderAdapter(opts);
}

async function executeRun(
  request: CellExecutionRequest,
  cell: { cell_id: string; model_id: ChepModelId; runs: readonly { run_id: string; replicate: number }[] },
  run: { run_id: string; replicate: number },
  adapter: ProviderAdapter,
  signal: AbortSignal | undefined,
  timeline: TimelineRecorder | undefined,
  replicate: number,
  identityAttestationTimeoutMs: number,
): Promise<CellRunResult> {
  const modelId = cell.model_id;
  const maxTokens = request.maxTokens ?? DEFAULT_EVALUATION_MAX_OUTPUT_TOKENS;
  const startTime = performance.now();
  const temperature = 0 as const;

  let runEventId: string | undefined;
  if (timeline !== undefined) {
    const tempJson = JSON.stringify({ temperature });
    const runRecord = timeline.recordRun({
      description: `Cell ${cell.cell_id} run ${replicate} for model ${modelId}`,
      correlation: { runId: run.run_id },
      outcome: "succeeded",
      documents: deepFreeze([
        {
          name: "temperature",
          contentJson: tempJson,
          contentDigest: sha256(tempJson),
        },
      ]),
    });
    runEventId = runRecord.eventId;
  }

  const attestation = await attestIdentity(adapter, modelId, maxTokens, signal, identityAttestationTimeoutMs);
  // CRIT-2 / MAJ-6: a hard identity failure (wrong probe content, probe call
  // failed, or a model mismatch) blocks the run — no main call is made. A
  // soft limitation (x-model-id header absent) continues the run but leaves
  // identityEstablished=false so the run is marked identity-unverified.
  if (!attestation.identityEstablished && attestation.blockRun) {
    if (timeline !== undefined && runEventId !== undefined) {
      timeline.recordEvent({
        eventType: "provider",
        description: `Identity not established for cell ${cell.cell_id} run ${replicate}`,
        correlation: { runId: run.run_id },
        parentEventId: runEventId,
        outcome: "failed",
        error: {
          category: "provider",
          code: attestation.failureReason ?? "identity_not_established",
          message: "capability probe did not return IDENTITY_PROBE_OK",
          // A blocked identity attestation is a hard stop, not a transient
          // fault; the run is abandoned rather than retried. Stated rather
          // than defaulted — the ledger now requires the caller to say.
          retryable: false,
        },
      });
    }
    // MAJ-7: include capabilityProbe so the probe's consumed tokens are counted
    // even when identity fails and the run is blocked.
    return deepFreeze({
      runId: run.run_id,
      replicate,
      content: "",
      usage: undefined,
      finishReason: "identity_not_established",
      durationMs: Math.round(performance.now() - startTime),
      temperature,
      error: null,
      modelRevision: attestation.modelRevision,
      isReference: false,
      oracleResults: deepFreeze([]),
      ...(attestation.capabilityProbe !== undefined ? { capabilityProbe: attestation.capabilityProbe } : {}),
    });
  }

  if (timeline !== undefined && attestation.capabilityProbe !== undefined && runEventId !== undefined) {
    const probe = attestation.capabilityProbe;
    const probeObj = {
      content: probe.content,
      usage: probe.usage,
      headers: probe.headers,
      finishReason: probe.finishReason,
      ...(probe.model !== undefined ? { model: probe.model } : {}),
    };
    const probeJson = JSON.stringify(probeObj);
    timeline.recordEvent({
      eventType: "provider",
      description: `Capability probe for cell ${cell.cell_id} run ${replicate}`,
      correlation: { runId: run.run_id },
      parentEventId: runEventId,
      outcome: "succeeded",
      documents: deepFreeze([
        {
          name: "probe-response",
          contentJson: probeJson,
          contentDigest: sha256(probeJson),
        },
      ]),
    });
  }

  const topology = findTopologyForCell(request.matrix, request.cellId);
  if (timeline !== undefined && topology !== undefined && topology.agent_count > 0 && runEventId !== undefined) {
    recordTopologyEvents(timeline, topology, cell.cell_id, run.run_id, replicate, runEventId);
  }

  const messages: ChatMessage[] = [
    deepFreeze({ role: "user", content: request.scenarioPrompt }),
  ];

  // C9: record the full serialized request body before the API call.
  const requestBody = deepFreeze({
    model: modelId,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    max_tokens: maxTokens,
    temperature: 0,
    stream: request.runReferenceTransport === true ? false : true,
  });
  if (timeline !== undefined && runEventId !== undefined) {
    const reqJson = JSON.stringify(requestBody);
    timeline.recordEvent({
      eventType: "provider",
      description: `Serialized request body for cell ${cell.cell_id} run ${replicate}`,
      correlation: { runId: run.run_id },
      parentEventId: runEventId,
      outcome: "succeeded",
      documents: deepFreeze([
        {
          name: "request-body",
          contentJson: reqJson,
          contentDigest: sha256(reqJson),
        },
      ]),
    });
  }

  let promptMessageEventId: string | undefined;
  if (timeline !== undefined && runEventId !== undefined) {
    const promptObj = { role: "user", content: request.scenarioPrompt };
    const promptJson = JSON.stringify(promptObj);
    const promptRecord = timeline.recordMessage({
      description: `Prompt for cell ${cell.cell_id} run ${replicate}`,
      correlation: { runId: run.run_id, turnId: "turn-1", messageId: generateShortId("msg") },
      parentEventId: runEventId,
      outcome: "succeeded",
      documents: deepFreeze([
        {
          name: "prompt",
          contentJson: promptJson,
          contentDigest: sha256(promptJson),
        },
      ]),
    });
    promptMessageEventId = promptRecord.eventId;
  }

  let result: ChatCompletionResult;
  try {
    result = request.runReferenceTransport
      ? await runReferenceTransport(request, modelId, messages, maxTokens, signal)
      : await adapter.chatCompletion({
          model: modelId,
          messages,
          max_tokens: maxTokens,
          temperature: 0,
          ...(signal !== undefined ? { signal } : {}),
        });
  } catch (error) {
    const message = extractErrorMessage(error);
    const durationMs = Math.round(performance.now() - startTime);
    if (timeline !== undefined && runEventId !== undefined) {
      timeline.recordEvent({
        eventType: "provider",
        description: `Provider call error for cell ${cell.cell_id} run ${replicate}`,
        correlation: { runId: run.run_id },
        parentEventId: runEventId,
        outcome: "failed",
        error: {
          category: "provider",
          code: "run_error",
          message,
          // The matrix executor does not re-drive a failed replicate, so
          // recording it as retryable would describe a recovery that never
          // happens. This preserves what was already stored (the previous
          // `errorRetryable ?? false` default) as an explicit statement.
          retryable: false,
        },
      });
    }
    return deepFreeze({
      runId: run.run_id,
      replicate,
      content: "",
      usage: undefined,
      finishReason: "error",
      durationMs,
      temperature,
      error: message,
      modelRevision: attestation.modelRevision,
      isReference: request.runReferenceTransport ?? false,
      oracleResults: deepFreeze([]),
    });
  }

  const durationMs = Math.round(performance.now() - startTime);

  let responseMessageEventId: string | undefined;
  if (timeline !== undefined && runEventId !== undefined) {
    const respObj = { role: "assistant", content: result.content };
    const respJson = JSON.stringify(respObj);
    const respRecord = timeline.recordMessage({
      description: `Response for cell ${cell.cell_id} run ${replicate}`,
      correlation: { runId: run.run_id, turnId: "turn-1", messageId: generateShortId("msg") },
      parentEventId: runEventId,
      outcome: "succeeded",
      documents: deepFreeze([
        {
          name: "response",
          contentJson: respJson,
          contentDigest: sha256(respJson),
        },
      ]),
    });
    responseMessageEventId = respRecord.eventId;
  }

  if (timeline !== undefined && result.toolCalls.length > 0 && runEventId !== undefined) {
    for (const tc of result.toolCalls) {
      const tcObj = { id: tc.id, name: tc.function.name, arguments: tc.function.arguments };
      const tcJson = JSON.stringify(tcObj);
      timeline.recordEvent({
        eventType: "tool",
        description: `Tool call ${tc.function.name} for cell ${cell.cell_id} run ${replicate}`,
        correlation: { runId: run.run_id, turnId: "turn-1" },
        parentEventId: runEventId,
        outcome: "succeeded",
        documents: deepFreeze([
          {
            name: "tool-call",
            contentJson: tcJson,
            contentDigest: sha256(tcJson),
          },
        ]),
      });
    }
  }

  if (timeline !== undefined && result.usage !== undefined) {
    const tokenParentId = responseMessageEventId ?? promptMessageEventId;
    timeline.recordTokenUsage({
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      totalTokens: result.usage.totalTokens,
      correlation: { runId: run.run_id, turnId: "turn-1" },
      outcome: "succeeded",
      ...(tokenParentId !== undefined ? { parentEventId: tokenParentId } : {}),
    });
  }

  // MAJ-12: parent the resource event to the run event so the timeline graph
  // links resource metrics to the run that produced them.
  if (timeline !== undefined && runEventId !== undefined) {
    timeline.recordResource({
      metric: "duration_ms",
      value: durationMs,
      unit: "ms",
      correlation: { runId: run.run_id },
      parentEventId: runEventId,
      outcome: "succeeded",
    });
  }

  const oracleResults = runOracles(request, result.content);
  const runOraclesPassed = oracleResults.length > 0 && oracleResults.every((o) => o.passed);
  // EVAL-1: record the oracle outcome in the queryable timeline so pass/fail
  // is not visible only in results.json. recordTest correlates to the runId.
  if (timeline !== undefined && runEventId !== undefined) {
    bestEffort(() => {
      const passedCount = oracleResults.filter((o) => o.passed).length;
      timeline.recordTest({
        description: `Oracle results for cell ${cell.cell_id} run ${replicate}: ${passedCount}/${oracleResults.length} passed`,
        passed: runOraclesPassed,
        testCount: oracleResults.length,
        correlation: { runId: run.run_id },
      });
    });
  }

  const topologyMeta: CellTopologyMeta | undefined = topology !== undefined
    ? deepFreeze({
        agentCount: topology.agent_count,
        communicationGraph: topology.communication_graph,
        workspaceMode: topology.workspace_mode,
        roles: deepFreeze(topology.roles.map((r) => deepFreeze({ roleId: r.role_id, specialty: r.specialty }))),
      })
    : undefined;

  return deepFreeze({
    runId: run.run_id,
    replicate,
    content: result.content,
    usage: result.usage,
    finishReason: result.finishReason,
    durationMs,
    temperature,
    error: null,
    modelRevision: attestation.modelRevision,
    isReference: request.runReferenceTransport ?? false,
    oracleResults: deepFreeze(oracleResults),
    ...(attestation.capabilityProbe !== undefined ? { capabilityProbe: attestation.capabilityProbe } : {}),
    ...(topologyMeta !== undefined ? { topology: topologyMeta } : {}),
  });
}

async function attestIdentity(
  adapter: ProviderAdapter,
  expectedModelId: string,
  maxTokens: number,
  signal: AbortSignal | undefined,
  identityAttestationTimeoutMs: number,
): Promise<Readonly<{
  identityEstablished: boolean;
  blockRun: boolean;
  modelRevision: CellRunResult["modelRevision"];
  capabilityProbe: CapabilityProbe | undefined;
  failureReason: string | undefined;
}>> {
  const probeMessages: ChatMessage[] = [
    deepFreeze({ role: "user", content: PROBE_PROMPT }),
  ];
  const probeLifetime = deadline(signal, identityAttestationTimeoutMs);
  const probeSignal = probeLifetime.signal;
  try {
    const result = await adapter.chatCompletion({
      model: expectedModelId,
      messages: probeMessages,
      max_tokens: maxTokens,
      temperature: 0,
      signal: probeSignal,
    });
    const headers: Readonly<Record<string, string>> = result.headers ?? deepFreeze({} as Record<string, string>);
    const providerRequestId = headers["x-request-id"] ?? null;
    const providerDate = headers["date"] ?? null;
    const bodyModel = result.model;
    const capabilityProbe: CapabilityProbe = deepFreeze({
      content: result.content,
      usage: result.usage,
      headers,
      finishReason: result.finishReason,
      ...(bodyModel !== undefined ? { model: bodyModel } : {}),
    });

    // C2: the probe response MUST contain the attestation marker. HTTP success
    // alone is not identity — a different model or echo proxy would not return it.
    // A wrong-content probe is a hard identity failure: block the run.
    if (!result.content.includes(IDENTITY_PROBE_MARKER)) {
      return {
        identityEstablished: false,
        blockRun: true,
        modelRevision: {
          requestedModelId: expectedModelId,
          returnedModelId: null,
          mappingStatus: "not-returned",
          providerRequestId,
          providerDate,
        },
        capabilityProbe,
        failureReason: "probe-response-mismatch",
      };
    }

    // C2 / DER-014: capture the returned model id. Priority: x-model-id
    // header > response body `model` field > null. Never fabricate it.
    // Makora (and many OpenAI-compatible providers) do not return the
    // x-model-id header; the body `model` field is the authoritative
    // fallback. Identity is established when EITHER source matches the
    // requested model. A mismatch in EITHER source blocks the run.
    const returnedModelIdHeader = headers["x-model-id"];
    const headerPresent = returnedModelIdHeader !== undefined && returnedModelIdHeader.length > 0;
    const bodyPresent = bodyModel !== undefined && bodyModel.length > 0;
    let returnedModelId: string | null;
    let mappingStatus: CellRunResult["modelRevision"]["mappingStatus"];
    let identityEstablished: boolean;
    let blockRun: boolean;
    if (headerPresent && returnedModelIdHeader === expectedModelId) {
      returnedModelId = returnedModelIdHeader;
      mappingStatus = "exact";
      identityEstablished = true;
      blockRun = false;
    } else if (headerPresent && returnedModelIdHeader !== expectedModelId) {
      // MAJ-6: a header model mismatch MUST block the run — the endpoint
      // profile declares model_fallback_allowed:false and
      // exact_model_string_required:true.
      returnedModelId = returnedModelIdHeader;
      mappingStatus = "mismatch-blocked";
      identityEstablished = false;
      blockRun = true;
    } else if (bodyPresent && bodyModel === expectedModelId) {
      // Header absent but body model matches → identity established via
      // the response body. This unblocks the full matrix for providers
      // (e.g. Makora) that do not return x-model-id.
      returnedModelId = bodyModel;
      mappingStatus = "exact-body";
      identityEstablished = true;
      blockRun = false;
    } else if (bodyPresent && bodyModel !== expectedModelId) {
      // Header absent and body model mismatches → a real mismatch.
      returnedModelId = bodyModel;
      mappingStatus = "mismatch-blocked";
      identityEstablished = false;
      blockRun = true;
    } else {
      // CRIT-2: both header AND body model absent → identity NOT fully
      // established (DER-014). Continue the run (do not waste tokens) but
      // mark it identity-unverified so it is excluded from the "passed"
      // count and reported as a limitation.
      returnedModelId = null;
      mappingStatus = "not-returned";
      identityEstablished = false;
      blockRun = false;
    }

    return {
      identityEstablished,
      blockRun,
      modelRevision: {
        requestedModelId: expectedModelId,
        returnedModelId,
        mappingStatus,
        providerRequestId,
        providerDate,
      },
      capabilityProbe,
      failureReason: blockRun ? "model-mismatch-blocked" : (identityEstablished ? undefined : "model-id-not-returned"),
    };
  } catch {
    return {
      identityEstablished: false,
      blockRun: true,
      modelRevision: {
        requestedModelId: expectedModelId,
        returnedModelId: null,
        mappingStatus: "not-returned",
        providerRequestId: null,
        providerDate: null,
      },
      capabilityProbe: undefined,
      failureReason: "probe-call-failed",
    };
  } finally {
    probeLifetime.clear();
  }
}

async function runReferenceTransport(
  request: CellExecutionRequest,
  modelId: string,
  messages: ChatMessage[],
  maxTokens: number,
  signal: AbortSignal | undefined,
): Promise<ChatCompletionResult> {
  const chatPath = request.providerConfig.chatCompletionsPath ?? "/chat/completions";
  const url = `${request.providerConfig.baseUrl.replace(/\/$/, "")}${chatPath}`;
  const body = deepFreeze({
    model: modelId,
    messages,
    max_tokens: maxTokens,
    temperature: 0,
    stream: false,
  });
  // An absent section is its schema's declared defaults (the one owner).
  const transport = resolveResponsesTransportConfig(request.providerConfig.responses ?? {});
  // Through the one outbound HTTP policy (no redirect followed, verified TLS,
  // the one cleartext decision, a bounded lifetime).
  const lifetime = deadline(signal, transport.operationTimeoutMs);
  let response: Response;
  let text: string;
  try {
    response = await outboundFetch({
      url, method: "POST",
      protocolHeaders: { "Content-Type": "application/json", "Authorization": `Bearer ${request.apiKey}` },
      // The evaluation operator's own provider configuration.
      allowPrivateAddress: privateAddressesAllowedFor(OPERATOR_OWNER),
      body: JSON.stringify(body),
      signal: lifetime.signal,
      logCategory: PROVIDER_LOG_CATEGORY,
    });
    text = response.ok ? await readBody(response, lifetime.signal, transport.maximumResponseBytes, transport.cleanupTimeoutMs, PROVIDER_LOG_CATEGORY) : "";
    if (!response.ok) await discardBody(response, PROVIDER_LOG_CATEGORY, transport.cleanupTimeoutMs);
  } finally {
    lifetime.clear();
  }
  if (!response.ok) {
    throw new HarnessError(`Reference transport HTTP ${response.status}`, "evaluation_reference_transport_failed");
  }
  const headers = extractResponseHeaders(response, transport);
  // The provider parser: V8's own message would quote the provider body (a2-design L5).
  const parsed: unknown = parseProviderJson(text);
  const obj = parsed as {
    model?: string;
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };
  const content = obj.choices?.[0]?.message?.content ?? "";
  const finishReason = obj.choices?.[0]?.finish_reason ?? "stop";
  const usage: TokenUsage | undefined = obj.usage !== undefined
    ? deepFreeze({ promptTokens: obj.usage.prompt_tokens, completionTokens: obj.usage.completion_tokens, totalTokens: obj.usage.total_tokens })
    : undefined;
  const model = obj.model;
  return deepFreeze({
    content,
    toolCalls: [] as readonly ToolCall[],
    usage,
    finishReason,
    headers,
    ...(model !== undefined && model.length > 0 ? { model } : {}),
  });
}

function findTopologyForCell(matrix: MatrixDocument, cellId: string): TopologyRecord | undefined {
  const cell = matrix.cells.find((c) => c.cell_id === cellId);
  if (cell === undefined) return undefined;
  const test = matrix.tests.find((t) => t.test_id === cell.test_id);
  if (test === undefined) return undefined;
  const condition = matrix.conditions.find((c) => c.condition_id === test.condition_id);
  return condition?.topology;
}

function recordTopologyEvents(
  timeline: TimelineRecorder,
  topology: TopologyRecord,
  cellId: string,
  runId: string,
  replicate: number,
  runEventId: string,
): void {
  for (const role of topology.roles) {
    const roleObj = {
      roleId: role.role_id,
      specialty: role.specialty,
      communicationGraph: topology.communication_graph,
      workspaceMode: topology.workspace_mode,
    };
    const roleJson = JSON.stringify(roleObj);
    timeline.recordEvent({
      eventType: "agent",
      description: `Agent ${role.role_id} (${role.specialty}) for cell ${cellId} run ${replicate}`,
      correlation: { runId, agentId: role.role_id },
      parentEventId: runEventId,
      outcome: "succeeded",
      edges: deepFreeze([{ edgeType: "part-of" as const, targetEventId: runEventId }]),
      documents: deepFreeze([
        {
          name: "agent-role",
          contentJson: roleJson,
          contentDigest: sha256(roleJson),
        },
      ]),
    });
  }
  const topoObj = {
    agentCount: topology.agent_count,
    communicationGraph: topology.communication_graph,
    workspaceMode: topology.workspace_mode,
    roles: topology.roles.map((r) => ({ roleId: r.role_id, specialty: r.specialty })),
  };
  const topoJson = JSON.stringify(topoObj);
  timeline.recordEvent({
    eventType: "task",
    description: `Topology ${topology.communication_graph} with ${topology.agent_count} agents for cell ${cellId} run ${replicate}`,
    correlation: { runId },
    parentEventId: runEventId,
    outcome: "succeeded",
    edges: deepFreeze([{ edgeType: "part-of" as const, targetEventId: runEventId }]),
    documents: deepFreeze([
      {
        name: "topology",
        contentJson: topoJson,
        contentDigest: sha256(topoJson),
      },
    ]),
  });
}

function runOracles(request: CellExecutionRequest, content: string): OracleCheckResult[] {
  const scenario = findScenarioForCell(request.matrix, request.cellId);
  const results: OracleCheckResult[] = [];
  if (scenario !== undefined) {
    for (const oracle of scenario.hidden_oracles) {
      results.push(checkOracle(oracle, content));
    }
  }
  // MAJ-9: anti-echo oracle. A model that simply echoes the prompt would pass
  // keyword-contains oracles. This oracle fails when the response contains the
  // first 50 chars of the prompt, catching pure echo responses. It is added to
  // every run's oracle set in addition to the scenario's hidden oracles.
  const promptPrefix = request.scenarioPrompt.slice(0, 50);
  if (promptPrefix.length > 0) {
    const antiEcho: HiddenOracle = deepFreeze({
      name: "not-echo",
      kind: "not-contains",
      pattern: promptPrefix,
      expected: true,
    });
    results.push(checkOracle(antiEcho, content));
  }
  return results;
}

function findScenarioForCell(matrix: MatrixDocument, cellId: string): ScenarioRecord | undefined {
  const cell = matrix.cells.find((c) => c.cell_id === cellId);
  if (cell === undefined) return undefined;
  const test = matrix.tests.find((t) => t.test_id === cell.test_id);
  if (test === undefined) return undefined;
  return matrix.scenarios.find((s) => s.scenario_id === test.scenario_id);
}

export function checkOracle(oracle: HiddenOracle, content: string): OracleCheckResult {
  let actual: boolean;
  switch (oracle.kind) {
    case "regex-match":
      actual = new RegExp(oracle.pattern).test(content);
      break;
    case "contains":
      actual = oracle.pattern.length === 0 ? content.length > 0 : content.includes(oracle.pattern);
      break;
    case "not-contains":
      actual = !content.includes(oracle.pattern);
      break;
    case "json-valid":
      try { JSON.parse(content); actual = true; } catch (e) {handleError(e, { module: "evaluation-scenario-runner", operation: "catch" }); actual = false; }
      break;
    case "line-count": {
      const lines = content.split("\n").length;
      actual = lines >= parseInt(oracle.pattern, 10);
      break;
    }
    default:
      actual = false;
  }
  return deepFreeze({
    name: oracle.name,
    passed: actual === oracle.expected,
    expected: oracle.expected,
    actual,
  });
}

function makeErrorResult(cellId: string, modelId: ChepModelId, error: string): CellResult {
  return deepFreeze({
    cellId,
    modelId,
    runs: deepFreeze([]),
    allOraclesPassed: false,
    identityAttested: false,
    error,
  });
}

export type { ChepArtifact };
