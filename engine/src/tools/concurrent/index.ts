/**
 * Concurrent tool dispatch — public surface.
 *
 * Re-exports the dispatcher, worker pool, dependency graph, long-task
 * runner, and the exposure layer. This is the single import point for
 * the concurrent tool execution capability.
 */

export {
  buildToolCallDependencyGraph,
  topologicalLevels,
  resolveExplicitDeps,
  DependencyCycleError,
  UnknownReferenceError,
  type ConcurrentToolCall,
  type DependencyGraph,
  type DependencyGraphOptions,
} from "./dependency-graph.ts";

export {
  WorkerPool,
  WorkerPoolError,
  type WorkerPoolOptions,
  type WorkerCall,
  type WorkerCallResult,
} from "./worker-pool.ts";

export {
  createConcurrentDispatcher,
  DispatcherError,
  type DispatchMode,
  type HandlerContext,
  type HandlerResult,
  type ToolHandler,
  type HandlerRegistry,
  type DispatcherConfig,
  type CallResult,
  type DispatchOutcome,
} from "./dispatcher.ts";

export {
  LongTaskRunner,
  LongTaskUnavailableError,
  LongTaskStartError,
  type LongTaskRunnerOptions,
  type StartOptions as LongTaskStartOptions,
  type StartedTask,
  type CheckResult as LongTaskCheckResult,
  type CheckStatus as LongTaskCheckStatus,
} from "./long-task-runner.ts";
