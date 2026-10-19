/** One dispatch gate for engine sessions and agents; hosts can supply their governed executor. */
import { deepFreeze } from "../kernel/integrity.ts";
import { InputError } from "../kernel/errors.ts";
import { createToolCallGate, type GateResult, type ToolCallGate, type ToolCallGateConfig } from "../safety/tool-call-gate.ts";
import type { ResponseActionAdmission } from "../shared/llm/responses-disposition.ts";
import type { ToolCall, ToolDefinition } from "./provider-adapter.ts";
import type { ToolRegistry, ToolResult } from "./tool-registry.ts";

export type GovernedToolExecution = Readonly<{
  /** Existing host port already owns schema, loop, capability and effect admission. */
  preflight(calls: readonly ToolCall[], definitions: readonly ToolDefinition[]): GateResult;
  /** Execute a call already admitted by preflight, without checking/counting it twice. */
  execute(call: ToolCall, signal?: AbortSignal): Promise<ToolResult>;
}>;
export type ToolDispatchHooks = Readonly<{
  beforeExecute?: (call: ToolCall) => void;
  afterExecute?: (call: ToolCall, result: ToolResult) => void;
  afterFailure?: (call: ToolCall, error: unknown) => void;
}>;
export type GovernedToolDispatch = Readonly<{
  admit: ResponseActionAdmission;
  execute(calls: readonly ToolCall[], definitions: readonly ToolDefinition[], signal?: AbortSignal, hooks?: ToolDispatchHooks): AsyncGenerator<Readonly<{ call: ToolCall; result: ToolResult }>, void, unknown>;
}>;
export function createGovernedToolDispatch(options: Readonly<{
  registry: ToolRegistry;
  repositoryRoot: string;
  definitions?: () => readonly ToolDefinition[];
  gate?: ToolCallGate;
  gateConfig?: ToolCallGateConfig;
  governedExecution?: GovernedToolExecution;
}>): GovernedToolDispatch {
  const definitions = options.definitions ?? (() => options.registry.definitions());
  const gate = options.governedExecution === undefined ? options.gate ?? createToolCallGate({
    getDefinitions: definitions,
    ...(options.gateConfig === undefined ? {} : { config: options.gateConfig }),
  }) : undefined;
  return Object.freeze({
    admit: action => action.kind === "function" && action.item.namespace === undefined &&
      (action.item.caller == null || (action.item.caller as { type?: unknown }).type === "direct") &&
      definitions().some(tool => tool.function.name === action.item.name) && options.registry.get(String(action.item.name)) !== undefined,
    async *execute(calls, admittedDefinitions, signal, hooks) {
      const checked = options.governedExecution
        ? options.governedExecution.preflight(calls, admittedDefinitions)
        : gate!.check(calls, admittedDefinitions);
      const clean = new Map(checked.clean.map(call => [call.id, call]));
      const blocked = new Map(checked.blocked.map(call => [call.toolCallId, call]));
      for (const original of calls) {
        if (signal?.aborted) throw new InputError("Tool execution cancelled", "tool_dispatch_cancelled");
        const refusal = blocked.get(original.id);
        if (refusal) {
          yield { call: original, result: deepFreeze({ toolCallId: original.id, name: original.function.name,
            content: refusal.errorMessage, isError: true }) };
          continue;
        }
        const call = clean.get(original.id)!;
        hooks?.beforeExecute?.(call);
        let result: ToolResult;
        try {
          result = options.governedExecution
            ? await options.governedExecution.execute(call, signal)
            : await options.registry.executeAsync({ id: call.id, name: call.function.name, arguments: call.function.arguments },
              { repositoryRoot: options.repositoryRoot }, signal);
        } catch (error) {
          hooks?.afterFailure?.(call, error);
          throw error;
        }
        hooks?.afterExecute?.(call, result);
        yield { call, result };
      }
    },
  });
}
