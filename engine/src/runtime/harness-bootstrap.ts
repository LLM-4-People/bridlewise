/**
 * Harness runtime bootstrap — the ONE place a production entry point makes
 * the harness's own recording machinery live.
 *
 * THE DEFECT THIS FIXES
 *
 * `registerAllExposure`, `withRecordingContext` and `setEffectSink` had ZERO
 * production call sites inside the harness itself: they were invoked only by
 * tests and by the WEB server (which wires its own sink in
 * `server/timeline-bridge.ts`). Anything driven through the harness directly —
 * the CLI, the direct `harness-commands` entry, `runCli` imported as the
 * package API — ran with an EMPTY exposure catalog and recorded nothing. The
 * machinery was correct and attached to nothing.
 *
 * WHAT THIS MODULE DOES
 *
 * `initializeHarnessRuntime()` is called at every production entry point
 * (mechanically enforced by `test/prevention/entrypoint-recording-wiring.test.ts`,
 * which discovers entry points from the source rather than from a list). It:
 *
 * 1. Populates the exposure catalog via `registerAllExposure()` (itself
 *    idempotent — each module guards its own registration).
 * 2. Installs ONE effect sink that acknowledges paired effects and completions to the harness's
 *    own canonical timeline ledger (`<root>/<state.root>/timeline.db` — the
 *    same file `harness timeline` queries), mirroring what the web server's
 *    timeline bridge does for the web ledger.
 *
 * IDEMPOTENCY / NO DOUBLE-SINK
 *
 * - A module-level flag makes repeated initialization a no-op, so nested
 *   entries (`runCli` dispatching into `runHarnessCli`) initialize exactly
 *   once.
 * - The sink slot is respected, never clobbered: when a sink is ALREADY
 *   installed (the web server's timeline bridge drove the harness first),
 *   this module leaves it in place. Exactly one sink exists either way, so
 *   no effect can be recorded twice.
 *
 * ACTOR HONESTY
 *
 * The recorder's construction fallback is deliberately `UNATTRIBUTED`, not a
 * plausible-looking default: an effect recorded outside any
 * `withRecordingContext` boundary shows up in the ledger as
 * `unattributed/unknown` — a visible wiring gap — rather than being silently
 * attributed to a hardcoded actor that lies. Real actors are established by
 * the entry points themselves (e.g. `{kind: "cli", id: <command>}`).
 *
 * The ledger is opened LAZILY, on the first recorded effect: a `--help` run
 * or a read-only query command must not create state directories as a side
 * effect of merely initializing.
 */

import { dirname, join } from "node:path";

import { loadPinnedConfigSnapshot } from "../kernel/config.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import { fileURLToPath } from "node:url";
import { installPromotionSource, installWorkspaceGitStateSource, registerAllExposure } from "../shared/exposure/registrations/index.ts";
import { enginePromotionSource } from "../workflow/promotion/context.ts";
import { indexBaselineSummary, recordIndexBaseline, repairIndexToBaseline } from "../git/index-baseline.ts";
import { clearDeclaredDeletions, declareDeletions, declaredDeletionsSummary } from "../git/declared-deletions.ts";
import { evidenceStoreSummary, evidenceSummary, materializeEvidence, trackedTop, verifyEvidence } from "../workflow/evidence-store.ts";
import { engineAndCheckoutRoots } from "../git/repository-ownership.ts";
import { workspaceRegistrySummary } from "../workflow/workspace-registry.ts";
import { resolveRepositoryRegistry } from "../workflow/repository-registry.ts";
import { configuredWorktreeGitPort } from "../git/worktree-port.ts";
import { worktreeOperationTimeouts } from "../workflow/workflow-config.ts";
import { journalsSummary } from "../filesystem/journaled-commit.ts";
import {
  createEngineCustomizationConfigStore,
  hasCustomizationConfigStore,
  installCustomizationConfigStore,
} from "../shared/exposure/index.ts";
import {
  hasEffectSink,
  setEffectSink,
  type EffectSink,
} from "../timeline/recorded-effect.ts";
import { UNATTRIBUTED } from "../timeline/recording-context.ts";
import { createTimelineRecorder } from "../timeline/timeline-recorder.ts";
import { createTimelineStore } from "../timeline/timeline-store.ts";
import type { EventLedgerStoragePort } from "../timeline/timeline-types.ts";
// Both real sinks share the document vocabulary, serialization and fitting owner.
import { createTimelineEffectSink } from "../timeline/effect-sink.ts";
import { DEFAULT_MAXIMUM_DOCUMENT_BYTES } from "../timeline/timeline-config.ts";
import { DEFAULT_RESOURCE_DELTAS_ENABLED } from "../performance/performance-config.ts";
import { ensurePrivateStateDirectory } from "../filesystem/private-state.ts";

/**
 * Stable ledger id for effects recorded by harness-driven processes.
 * Named like `workspace-integrator` so a cross-ledger investigation
 * (`harness timeline`, which queries `event_log` across ledger ids) can tell
 * harness-runtime effects apart from workspace shards and eval runs.
 */
export const HARNESS_RUNTIME_LEDGER_ID = "harness-runtime" as const;

export type HarnessRuntimeBootstrapOptions = Readonly<{
  /** Repository root the state directory hangs off. Defaults to `process.cwd()`. */
  root?: string;
  /** Explicit ledger db path (tests). Overrides the config-derived default. */
  ledgerPath?: string;
}>;

export type HarnessRuntimeInitialization = Readonly<{
  /** True when THIS call performed initialization (first call in the process). */
  performed: boolean;
  /** True when THIS call installed the harness ledger sink. */
  sinkInstalled: boolean;
  /** True when some sink already existed before this call (e.g. the web bridge's). */
  sinkAlreadyPresent: boolean;
}>;

let initialized = false;
let activeStore: EventLedgerStoragePort | undefined;
let installedSink: EffectSink | undefined;

/** One lazy recorder and one resolved configuration for both recording phases. */
function createLedgerSink(options: HarnessRuntimeBootstrapOptions): EffectSink {
  let target: ReturnType<Parameters<typeof createTimelineEffectSink>[0]>;
  let openFailed = false;
  return createTimelineEffectSink(() => {
    if (openFailed) return undefined;
    if (target !== undefined) return target;
    try {
      const config = loadPinnedConfigSnapshot().document;
      const dbPath = options.ledgerPath ?? join(options.root ?? process.cwd(), config.state.root, "timeline.db");
      ensurePrivateStateDirectory(dirname(dbPath));
      activeStore = createTimelineStore({ path: dbPath, ledgerId: HARNESS_RUNTIME_LEDGER_ID, ...(config.timeline !== undefined ? { timelineConfig: config.timeline } : {}) });
      target = {
        recorder: createTimelineRecorder({ store: activeStore, actor: UNATTRIBUTED }),
        documentOptions: {
          maxDocumentBytes: config.timeline?.maxDocumentBytes ?? DEFAULT_MAXIMUM_DOCUMENT_BYTES,
          resourceDeltasEnabled: config.performance?.resourceDeltas.enabled ?? DEFAULT_RESOURCE_DELTAS_ENABLED,
        },
      };
      return target;
    } catch (error) {
      openFailed = true;
      throw error;
    }
  });
}

/**
 * The engine's own checkout's git state for the `workspaceGit` rows (the live
 * index baseline, the declared deletions, the stored evidence and the journals:
 * `harness index`, `harness deletions`, `harness evidence` and `harness check`'s answers). Installed HERE, in the engine's own processes: the web server
 * starts no process outside its confinement owner, so it does not install
 * this source and its rows read `unmeasured`.
 */
function installEngineWorkspaceGitState(): void {
  const engineRoot = fileURLToPath(new URL("../../", import.meta.url));
  installWorkspaceGitStateSource({
    liveIndexState: () => indexBaselineSummary(engineRoot),
    journals: () => journalsSummary(engineAndCheckoutRoots(engineRoot)),
    recordIndex: () => recordIndexBaseline(engineRoot),
    repairIndex: () => repairIndexToBaseline(engineRoot),
    declaredDeletions: () => declaredDeletionsSummary(engineRoot),
    declareDeletion: (path) => declareDeletions(engineRoot, [path]),
    clearDeclaredDeletions: () => clearDeclaredDeletions(engineRoot),
    evidence: () => evidenceSummary(engineRoot),
    evidenceStore: () => evidenceStoreSummary(),
    verifyEvidence: () => verifyEvidence(trackedTop(engineRoot)),
    materializeEvidence: (path) => materializeEvidence(trackedTop(engineRoot), [path]),
    workspaces: () => {
      const document = loadPinnedConfigSnapshot().document;
      return workspaceRegistrySummary(resolveRepositoryRegistry(configuredWorktreeGitPort(document), engineRoot, worktreeOperationTimeouts(document).inspectMs));
    },
    sweepWorkspaces: async () => (await import("../workflow/workspace-cli.ts")).runWorkspaceCli(engineRoot, ["sweep"]),
  });
}

/**
 * Initialize the harness runtime: exposure catalog + ledger effect sink.
 * Idempotent (repeated calls no-op) and non-clobbering (an existing sink —
 * the web bridge's, or an earlier initialization's — is left in place, so
 * exactly one sink exists and nothing is recorded twice).
 */
export function initializeHarnessRuntime(
  options: HarnessRuntimeBootstrapOptions = {},
): HarnessRuntimeInitialization {
  if (initialized) {
    return deepFreeze({ performed: false, sinkInstalled: false, sinkAlreadyPresent: hasEffectSink() });
  }
  initialized = true;
  // Install the config store BEFORE the exposure surface registers, so a
  // config-bound customization's projection is seeded from the config file and
  // its first `set` writes through the schema gate. Non-clobbering: a host
  // that already installed a store (the web server's writeConfigRaw-backed
  // one) is left in place — the engine's file-backed store is the CLI's door.
  if (!hasCustomizationConfigStore()) {
    installCustomizationConfigStore(createEngineCustomizationConfigStore());
  }
  registerAllExposure();
  installEngineWorkspaceGitState();
  // The promotion surface over the engine's own checkout (the web server
  // installs none: it runs no git).
  installPromotionSource(enginePromotionSource(fileURLToPath(new URL("../../", import.meta.url))));
  const sinkAlreadyPresent = hasEffectSink();
  if (!sinkAlreadyPresent) {
    installedSink = createLedgerSink(options);
    setEffectSink(installedSink);
  }
  return deepFreeze({ performed: true, sinkInstalled: !sinkAlreadyPresent, sinkAlreadyPresent });
}

/**
 * Test-only teardown: close the ledger and uninstall ONLY the sink this
 * module installed (a foreign sink — the web bridge's — is never touched),
 * then allow a fresh initialization.
 */
export function resetHarnessRuntimeForTesting(): void {
  if (activeStore !== undefined) {
    activeStore.close();
    activeStore = undefined;
  }
  if (installedSink !== undefined) {
    setEffectSink(undefined);
    installedSink = undefined;
  }
  initialized = false;
}
