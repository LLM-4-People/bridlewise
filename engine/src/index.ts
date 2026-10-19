/**
 * Public API barrel for bridlewise.
 *
 * Exposes the key factory functions and their option/result types so the
 * harness can be embedded as a library. Uses explicit named re-exports only
 * (no `export *`) so the public surface stays explicit and tree-shakeable.
 */

export { runCli } from "./cli.ts";

export { createProviderAdapter } from "./runtime/provider-adapter.ts";
export type {
  ProviderAdapter,
  ProviderAdapterOptions,
  ChatMessage,
  ChatCompletionRequest,
  ChatStreamEvent,
  TokenUsage,
  ToolCall,
  ToolDefinition,
  ProviderConfig,
} from "./runtime/provider-adapter.ts";

export { createToolRegistry } from "./runtime/tool-registry.ts";
export type {
  ToolRegistry,
  RegisteredTool,
  ToolResult,
  ToolContext,
  ToolRegistryOptions,
} from "./runtime/tool-registry.ts";

export {
  assertString,
  optionalString,
  resolveBoolean,
  resolvePositiveInt,
} from "./runtime/tool-args.ts";
export type {
  AssertStringOptions,
  ResolvePositiveIntOptions,
} from "./runtime/tool-args.ts";

export { createInteractiveSession } from "./runtime/interactive-session.ts";
export type {
  InteractiveSession,
  InteractiveSessionOptions,
  SessionEvent,
  TurnResult,
  SessionState,
} from "./runtime/interactive-session.ts";

export { createTimelineStore } from "./timeline/timeline-store.ts";
export type { EventLedgerStoragePort } from "./timeline/timeline-store.ts";
export { createTimelineRecorder } from "./timeline/timeline-recorder.ts";
export type { TimelineRecorder, TimelineRecorderOptions } from "./timeline/timeline-recorder.ts";

export { createOrchestrator } from "./agents/orchestrator.ts";
export type {
  Orchestrator,
  OrchestratorOptions,
  OrchestrationResult,
  OrchestrationPlan,
  OrchestrationEvent,
} from "./agents/orchestrator.ts";

export { createMemoryStore } from "./memory/memory-store.ts";
export type { MemoryStore, MemoryStoreOptions } from "./memory/memory-store.ts";
export { createUnifiedContextManager } from "./memory/unified/unified-context-manager.ts";
export type { UnifiedContextManager, ContextTurn as UnifiedContextTurn, ContextToolCall, ContextRole, AddTurnInput as UnifiedAddTurnInput, ContextSummary as UnifiedContextSummary, ContextState as UnifiedContextState } from "./memory/unified/unified-context-manager.ts";

export { createTransactionalEditor } from "./editor/transactional-editor.ts";
export type { TransactionalEditor, TransactionalEditorOptions } from "./editor/transactional-editor.ts";

export { createMetricsCollector } from "./performance/metrics-collector.ts";
export type { MetricsCollector, MetricsSnapshot, MetricsCollectorOptions } from "./performance/metrics-collector.ts";

export { loadPinnedConfigSnapshot } from "./kernel/config.ts";
export type { ConfigSnapshot, ConfigDocument } from "./kernel/config.ts";
