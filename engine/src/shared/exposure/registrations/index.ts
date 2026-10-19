/**
 * Shared exposure registrations — central entry point.
 *
 * Imports every per-module registration file and exposes ONE
 * `registerAllExposure` function that registers every signal,
 * action, and customization for every module in one call.
 *
 * This is the SINGLE import a harness bootstrap uses to make the
 * entire exposure surface live:
 *
 * ```ts
 * import { registerAllExposure } from "../shared/exposure/registrations/index.ts";
 * registerAllExposure;
 * ```
 *
 * After this call, the shared registry is fully populated and
 * every consumer (CLI, LLM context injector, extensions, tests) can
 * read signals, execute actions, and read/set customizations.
 *
 * Each module's registration is idempotent (guarded by a `*Registered`
 * flag), so `registerAllExposure` is safe to call multiple times.
 */

import { InputError } from "../../../kernel/errors.ts";
import { clearAll, countAll } from "../index.ts";
import {
  createEngineCustomizationConfigStore,
  hasCustomizationConfigStore,
  installCustomizationConfigStore,
} from "../config-binding.ts";
import { registerAwarenessExposure, resetAwarenessRegistration } from "./awareness.ts";
import { registerBiasExposure, resetBiasRegistration } from "./bias.ts";
import { registerContextExposure, resetContextRegistration } from "./context.ts";
import { registerDedupExposure, resetDedupRegistration } from "./dedup.ts";
import { registerEditorExposure, resetEditorRegistration } from "./editor.ts";
import { registerHallucinationExposure, resetHallucinationRegistration } from "./hallucination.ts";
import { registerLearningExposure, resetLearningRegistration } from "./learning.ts";
import { registerMemoryExposure, resetMemoryRegistration } from "./memory.ts";
import { registerMcpExposure, resetMcpRegistration } from "./mcp.ts";
import { registerIntelligenceExposure, resetIntelligenceRegistration } from "./intelligence.ts";
import { registerGraphExposure, resetGraphRegistration } from "./graph.ts";
import { registerArtifactsExposure, resetArtifactsRegistration } from "./artifacts.ts";
import { registerPrivacyExposure, resetPrivacyRegistration } from "./privacy.ts";
import { registerQualityExposure, resetQualityRegistration } from "./quality.ts";
import { registerRedactionExposure, resetRedactionRegistration } from "./redaction.ts";
import { registerSafetyExposure, resetSafetyRegistration } from "./safety.ts";
import { registerSearchExposure, resetSearchRegistration } from "./search.ts";
import { registerToolsExposure, resetToolsRegistration } from "./tools.ts";
import { registerTimelineExposure, resetTimelineRegistration } from "./timeline.ts";
import { registerPerformanceExposure, resetPerformanceRegistration } from "./performance.ts";
import { registerWebPerformanceExposure, resetWebPerformanceRegistration } from "./web-performance.ts";
import { registerWorkspaceGitExposure, resetWorkspaceGitRegistration } from "./workspace-git.ts";
import { registerPromotionExposure, resetPromotionRegistration } from "./promotion.ts";
import { registerTestExecutionExposure, resetTestExecutionRegistration } from "./test-execution.ts";
import { registerHarnessCommandsExposure, resetHarnessCommandsRegistration } from "./harness-commands.ts";
import { registerAgentsExposure, resetAgentsRegistration } from "./agents.ts";
import { registerSettingsExposure, resetSettingsRegistration } from "./settings.ts";
import { registerNetworkExposure, resetNetworkRegistration } from "./network.ts";
import { registerDatabaseExposure, resetDatabaseRegistration } from "./database.ts";
import { registerProcessExposure, resetProcessRegistration } from "./process.ts";

/**
 * The complete, ordered list of module registration functions.
 * Order matters only for registration-order in the central registry;
 * consumers should not rely on it semantically.
 */
const MODULE_REGISTRATIONS = [
  ["search", registerSearchExposure],
  ["memory", registerMemoryExposure],
  ["awareness", registerAwarenessExposure],
  ["editor", registerEditorExposure],
  ["quality", registerQualityExposure],
  ["safety", registerSafetyExposure],
  ["learning", registerLearningExposure],
  ["context", registerContextExposure],
  ["tools", registerToolsExposure],
  ["hallucination", registerHallucinationExposure],
  ["bias", registerBiasExposure],
  ["privacy", registerPrivacyExposure],
  ["redaction", registerRedactionExposure],
  ["dedup", registerDedupExposure],
  ["mcp", registerMcpExposure],
  ["intelligence", registerIntelligenceExposure],
  ["graph", registerGraphExposure],
  ["artifacts", registerArtifactsExposure],
  ["timeline", registerTimelineExposure],
  ["performance", registerPerformanceExposure],
  ["webPerformance", registerWebPerformanceExposure],
  ["workspaceGit", registerWorkspaceGitExposure],
  ["promotion", registerPromotionExposure],
  ["testExecution", registerTestExecutionExposure],
  ["harnessCommands", registerHarnessCommandsExposure],
  ["agents", registerAgentsExposure],
  ["settings", registerSettingsExposure],
  ["network", registerNetworkExposure],
  ["database", registerDatabaseExposure],
  ["process", registerProcessExposure],
] as const;

/**
 * Register every module's signals, actions, and customizations.
 * Idempotent: each module guards its own registration.
 *
 * ── THE POPULATION FLOOR, AND WHAT IT CAN AND CANNOT SEE ─────────────────
 *
 * `registrations/shared.ts` sat beside these files for the life of the
 * directory and was never in the list above. Driven, its five signals did not
 * exist at runtime; tree-shaking had already deleted its symbols from
 * `dist/bundle.js`, and that deletion is what `bundleSha256` certifies — so
 * the shipped artefact never contained it and nothing ever noticed. The
 * guard that should have caught it iterated the same list, and therefore
 * passed vacuously.
 *
 * The floor below catches the half a runtime CAN see: a module that is in the
 * list, is imported, runs, and contributes nothing — the wired-but-inert
 * shape. It cannot catch the half that was actually wrong, and the reason is
 * worth writing down rather than papering over: a module nobody imports has
 * no runtime existence at all, so no amount of runtime checking can find it.
 * That half needs the filesystem, and it is asserted in the exposure
 * registration test against `readdirSync` of this directory.
 */
export function registerAllExposure(): void {
  // A config-bound customization reads/writes `bridlewise.config.json`
  // through the installed store. Install the engine's file-backed store when
  // the host has not installed its own (the web server installs a
  // `writeConfigRaw`-backed store before this runs). Installing HERE — at the
  // single door every host passes through — means no caller can register the
  // surface and leave a config-bound knob without a backing store. The seed
  // for each knob's projection happens at module import, before this runs, so
  // an already-installed store (the server's) is what those seeds read.
  if (!hasCustomizationConfigStore()) {
    installCustomizationConfigStore(createEngineCustomizationConfigStore());
  }
  const before = countAll();
  const empty: string[] = [];
  for (const [name, register] of MODULE_REGISTRATIONS) {
    const at = countAll();
    register();
    if (countAll() === at && before === 0) empty.push(name);
  }
  if (empty.length > 0) {
    throw new InputError(
      `exposure modules registered nothing: ${empty.join(", ")}. A registration that runs and contributes ` +
      "no signal, action or customization is indistinguishable from one that was never wired, and every " +
      "consumer reads the registry rather than this list.",
    );
  }
}

/** Names of every registered module, in registration order. */
export function registeredModuleNames(): readonly string[] {
  return MODULE_REGISTRATIONS.map(([name]) => name);
}

/**
 * Reset every per-module `*Registered` flag WITHOUT touching the central
 * registry. Tests that want a clean slate should call `resetAllRegistrations`
 * (which also clears the registry) instead of this function directly.
 */
function resetRegistrationFlags(): void {
  resetSearchRegistration();
  resetMemoryRegistration();
  resetAwarenessRegistration();
  resetEditorRegistration();
  resetQualityRegistration();
  resetSafetyRegistration();
  resetLearningRegistration();
  resetContextRegistration();
  resetToolsRegistration();
  resetHallucinationRegistration();
  resetBiasRegistration();
  resetPrivacyRegistration();
  resetRedactionRegistration();
  resetDedupRegistration();
  resetMcpRegistration();
  resetIntelligenceRegistration();
  resetGraphRegistration();
  resetArtifactsRegistration();
  resetTimelineRegistration();
  resetPerformanceRegistration();
  resetWebPerformanceRegistration();
  resetWorkspaceGitRegistration();
  resetPromotionRegistration();
  resetTestExecutionRegistration();
  resetHarnessCommandsRegistration();
  resetAgentsRegistration();
  resetSettingsRegistration();
  resetNetworkRegistration();
  resetDatabaseRegistration();
  resetProcessRegistration();
}

/**
 * Full reset: clear the central registry AND every per-module
 * `*Registered` flag. After this call, `registerAllExposure` repopulates
 * the entire exposure surface from scratch. Test-only.
 */
export function resetAllRegistrations(): void {
  clearAll();
  resetRegistrationFlags();
}

// Re-export each module's state object for tests and downstream wiring.
export { awarenessState } from "./awareness.ts";
export { biasState } from "./bias.ts";
export { contextState } from "./context.ts";
export { editorState } from "./editor.ts";
export { hallucinationState } from "./hallucination.ts";
export { learningState } from "./learning.ts";
export { memoryState } from "./memory.ts";
export { qualityState } from "./quality.ts";
export { safetyState } from "./safety.ts";
export { searchState } from "./search.ts";
export { toolsState } from "./tools.ts";

// Re-export each per-module register function.
export { registerAwarenessExposure } from "./awareness.ts";
export { registerBiasExposure } from "./bias.ts";
export { registerContextExposure } from "./context.ts";
export { registerEditorExposure } from "./editor.ts";
export { registerHallucinationExposure } from "./hallucination.ts";
export { registerLearningExposure } from "./learning.ts";
export { registerMemoryExposure } from "./memory.ts";
export { registerQualityExposure } from "./quality.ts";
export {
  registerSafetyExposure,
  installKeepOutSource,
  installSafetyEventFeedStateSource,
  clearSafetyEventFeedStateSource,
  type SafetyEventFeedState,
  type SafetyEventFeedStateSource,
} from "./safety.ts";
export { registerSearchExposure } from "./search.ts";
export { registerToolsExposure } from "./tools.ts";
export { registerTimelineExposure, installTimelineReadinessSource, type TimelineReadinessFacts } from "./timeline.ts";
export {
  registerPerformanceExposure,
  installPerformanceMetricsSource,
  clearPerformanceMetricsSource,
  type PerformanceMetricsState,
  type PerformanceMetricsStateSource,
} from "./performance.ts";
export {
  registerWebPerformanceExposure,
} from "./web-performance.ts";
export { registerPrivacyExposure, installEgressFailureSource, type EgressFailureCounts } from "./privacy.ts";
export {
  registerRedactionExposure,
  installRedactionMemoSource,
  clearRedactionMemoSource,
  type RedactionMemoState,
  type RedactionMemoStateSource,
} from "./redaction.ts";
export {
  registerIntelligenceExposure,
  installIntelligenceMapCacheSource,
  installIntelligenceMapCacheInvalidate,
  clearIntelligenceMapCacheSource,
  type IntelligenceMapCacheState,
  type IntelligenceMapCacheStateSource,
  type IntelligenceMapCacheInvalidate,
} from "./intelligence.ts";
export { registerGraphExposure } from "./graph.ts";
export { registerArtifactsExposure } from "./artifacts.ts";
export { registerWorkspaceGitExposure, installWorkspaceGitStateSource, type WorkspaceGitStateSource } from "./workspace-git.ts";
export { registerPromotionExposure, installPromotionSource, type PromotionSource } from "./promotion.ts";
export { registerTestExecutionExposure } from "./test-execution.ts";
export { registerHarnessCommandsExposure } from "./harness-commands.ts";
export { registerAgentsExposure } from "./agents.ts";
export { registerNetworkExposure } from "./network.ts";
export { registerDatabaseExposure, installDatabaseFactsSource, installDatabaseThreadsSource, installDatabaseKeyTool, installDatabaseShellOperations, type DatabaseShellOperations, type DatabaseKeyTool, type DatabaseSafetyFacts, type DatabaseThreadFacts } from "./database.ts";
export {
  registerSettingsExposure,
  installSettingsStoreStateSource,
} from "./settings.ts";
