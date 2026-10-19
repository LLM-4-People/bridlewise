import { extractErrorMessage, HarnessError, InputError, isAbortError, SecurityError } from "../kernel/errors.ts";
import { bestEffort } from "../shared/best-effort.ts";
import { canonicalHash, deepFreeze, generateId } from "../kernel/integrity.ts";
import { deadline } from "../shared/abort-signals.ts";
import type { ToolManifest, ToolManifestEntry, ToolResourceBounds } from "./tool-manifest.ts";
import { mergeBounds } from "./tool-manifest.ts";

/**
 * Tool adapter framework — the typed async execution layer for governed
 * tools.
 *
 * Every tool (built-in or MCP-provided) implements the `ToolAdapter`
 * interface: an async `execute(input, context)` that supports
 * cancellation via `AbortSignal`, bounded resources (timeout, output
 * size, memory), complete logging to a `ToolEffectRecorder` port, and
 * typed errors.
 *
 * The `ToolEffectRecorder` is a minimal port interface. The application
 * layer (timeline recorder) provides a concrete implementation; the
 * adapter framework stays in the infrastructure layer and does not
 * import application-layer modules, preserving dependency direction.
 *
 * Bounded execution:
 * - A per-call `AbortController` combines the caller's signal with a
 * timeout derived from the manifest entry's bounds.
 * - Output exceeding `maxOutputBytes` is truncated and flagged.
 * - All errors are normalized to `ToolAdapterError` with stable codes.
 */

export type ToolAdapterInput = Readonly<{
  toolId: string;
  arguments: Readonly<Record<string, unknown>>;
  correlation?: Readonly<{
    runId?: string;
    sessionId?: string;
    turnId?: string;
    agentId?: string;
    attemptId?: string;
  }>;
}>;

export type ToolAdapterResult = Readonly<{
  toolId: string;
  content: string;
  isError: boolean;
  structured?: Readonly<Record<string, unknown>>;
  metadata?: Readonly<Record<string, unknown>>;
  durationMs: number;
  truncated: boolean;
  cancelled: boolean;
}>;

export type ToolAdapterContext = Readonly<{
  repositoryRoot: string;
  boundsOverride?: Partial<ToolResourceBounds>;
  recorder?: ToolEffectRecorder;
  signal?: AbortSignal;
}>;

export type ToolEffectRecorder = Readonly<{
  beginEffect(input: Readonly<{
    effectId: string;
    kind: string;
    description: string;
    intentHash: string;
    correlation?: Readonly<Record<string, string | undefined>>;
  }>): void;
  endEffect(effectId: string, input: Readonly<{
    outcome: "succeeded" | "failed" | "cancelled";
    resultHash: string;
    error?: Readonly<{ category: string; code: string; message: string; retryable: boolean }>;
  }>): void;
}>;

export interface ToolAdapter {
  readonly adapterId: string;
  execute(input: ToolAdapterInput, context: ToolAdapterContext): Promise<ToolAdapterResult>;
}

export class ToolAdapterError extends HarnessError {
  constructor(
    message: string,
    code = "tool_adapter_error",
    retryable = false,
    safeDetails: Readonly<Record<string, string | number | boolean>> = {},
  ) {
    super(message, code, retryable, safeDetails);
  }
}

export type BoundedToolAdapter = ToolAdapter & Readonly<{
  readonly manifest: ToolManifest;
  readonly entry: ToolManifestEntry;
}>;

function resolveBounds(entry: ToolManifestEntry, context: ToolAdapterContext): ToolResourceBounds {
  return mergeBounds(entry.bounds, context.boundsOverride);
}

function truncateOutput(content: string, maxBytes: number): Readonly<{ text: string; truncated: boolean }> {
  const byteLength = Buffer.byteLength(content, "utf8");
  if (byteLength <= maxBytes) return { text: content, truncated: false };
  const encoder = new TextEncoder();
  const encoded = encoder.encode(content);
  const sliced = encoded.slice(0, maxBytes);
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let text = decoder.decode(sliced);
  const ellipsis = "\n...[truncated]";
  if (Buffer.byteLength(text + ellipsis, "utf8") <= maxBytes) {
    text += ellipsis;
  }
  return { text, truncated: true };
}

export function createBoundedToolAdapter(
  adapter: ToolAdapter,
  manifest: ToolManifest,
  entry: ToolManifestEntry,
): BoundedToolAdapter {
  const resolved = manifest.get(entry.id);
  if (resolved === undefined) {
    throw new InputError(
      `Tool manifest entry '${entry.id}' is not registered`,
      "tool_adapter_manifest_missing",
    );
  }
  if (resolved.adapterId !== adapter.adapterId) {
    throw new InputError(
      `Adapter '${adapter.adapterId}' does not match manifest adapterId '${resolved.adapterId}' for tool '${entry.id}'`,
      "tool_adapter_id_mismatch",
    );
  }
  return deepFreeze({
    adapterId: adapter.adapterId,
    manifest,
    entry: resolved,
    async execute(input: ToolAdapterInput, context: ToolAdapterContext): Promise<ToolAdapterResult> {
      if (input.toolId !== entry.id) {
        throw new ToolAdapterError(
          `Tool id mismatch: expected '${entry.id}', got '${input.toolId}'`,
          "tool_adapter_id_mismatch",
        );
      }
      const bounds = resolveBounds(resolved, context);
      const startMs = performance.now();
      const effectId = generateId(`tool-${entry.id}`);
      const intentHash = canonicalHash({ toolId: entry.id, arguments: input.arguments });
      const recorder = context.recorder;
      if (recorder !== undefined) {
        bestEffort(() => recorder.beginEffect({
          effectId,
          kind: "process",
          description: `Tool execution: ${entry.name}`,
          intentHash,
          ...(input.correlation !== undefined ? { correlation: input.correlation } : {}),
        }));
      }
      const lifetime = deadline(context.signal, bounds.timeoutMs);
      const combinedSignal = lifetime.signal;
      const innerContext: ToolAdapterContext = Object.freeze({
        repositoryRoot: context.repositoryRoot,
        signal: combinedSignal,
      });
      let result: ToolAdapterResult;
      try {
        const raw = await adapter.execute(input, innerContext);
        const truncation = truncateOutput(raw.content, bounds.maxOutputBytes);
        result = deepFreeze({
          toolId: raw.toolId,
          content: truncation.text,
          isError: raw.isError,
          ...(raw.structured !== undefined ? { structured: raw.structured } : {}),
          ...(raw.metadata !== undefined ? { metadata: raw.metadata } : {}),
          durationMs: Math.round(performance.now() - startMs),
          truncated: truncation.truncated,
          cancelled: false,
        });
      } catch (error) {
        lifetime.clear();
        const cancelled = combinedSignal.aborted;
        // An aborted lifetime is cancellation even when its private reason is an
        // ordinary Error/string or a typed domain error. Keep that reason out of evidence.
        const adapterError = cancelled || isAbortError(error)
          ? new ToolAdapterError("Tool execution cancelled", "tool_adapter_cancelled", false)
          : error instanceof ToolAdapterError ? error
            : error instanceof HarnessError
              ? new ToolAdapterError(error.message, error.code, error.retryable, error.safeDetails)
              : new ToolAdapterError(extractErrorMessage(error), "tool_adapter_execution_failed", false);
        result = deepFreeze({
          toolId: entry.id,
          content: cancelled ? "" : adapterError.message,
          isError: true,
          durationMs: Math.round(performance.now() - startMs),
          truncated: false,
          cancelled,
        });
        if (recorder !== undefined) {
          bestEffort(() => recorder.endEffect(effectId, {
            outcome: cancelled ? "cancelled" : "failed",
            resultHash: canonicalHash({ effectId, error: adapterError.code }),
            error: {
              category: "tool",
              code: adapterError.code,
              message: adapterError.message,
              retryable: adapterError.retryable,
            },
          }));
        }
        return result;
      }
      lifetime.clear();
      if (recorder !== undefined) {
        bestEffort(() => recorder.endEffect(effectId, {
          outcome: result.isError ? "failed" : "succeeded",
          resultHash: canonicalHash({ effectId, content: result.content }),
        }));
      }
      return result;
    },
  });
}

export { isAbortError };

export function createToolEffectRecorderBridge(
  recorder: Readonly<{
    beginEffect: (input: Readonly<{
      effectId: string;
      kind: string;
      actor: Readonly<{ kind: string; id: string; role?: string }>;
      description: string;
      intentHash: string;
      correlation?: Readonly<Record<string, string | undefined>>;
    }>) => unknown;
    endEffect: (effectId: string, input: Readonly<{
      outcome: string;
      resultHash: string;
      error?: Readonly<{ category: string; code: string; message: string; retryable: boolean }>;
    }>) => unknown;
  }>,
): ToolEffectRecorder {
  const actor = deepFreeze({ kind: "harness", id: "tool-adapter", role: "tools" });
  return deepFreeze({
    beginEffect(input): void {
      recorder.beginEffect({
        effectId: input.effectId,
        kind: input.kind,
        actor,
        description: input.description,
        intentHash: input.intentHash,
        ...(input.correlation !== undefined ? { correlation: input.correlation } : {}),
      });
    },
    endEffect(effectId, input): void {
      recorder.endEffect(effectId, {
        outcome: input.outcome,
        resultHash: input.resultHash,
        ...(input.error !== undefined ? { error: input.error } : {}),
      });
    },
  });
}

export { SecurityError as ToolSecurityError };
