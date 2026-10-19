/**
 * Shared exposure registrations — `editor` module.
 *
 * Owns a small per-process state object that mirrors what the real
 * `TransactionalEditor` would expose. All signals read from this state,
 * all actions mutate it, and all customizations read/set it — through
 * the shared exposure system.
 */

import {
  registerAction,
  registerCustomization,
  registerExposureModule,
  registerSignal,
  configBoundSet,
  seedFromConfig,
  syncStateFromConfig,
} from "../index.ts";

/** Per-process editor state. */
export const editorState = {
  editCount: 0,
  successCount: 0,
  failureCount: 0,
  rollbackCount: 0,
  autoHealTriggerCount: 0,
  totalEditsApplied: 0,
  lastEditAt: 0,
  // The edit-behaviour knobs are a LIVE PROJECTION of the `editor` config
  // section: seeded from `bridlewise.config.json` and written back through
  // the config gate on every `set`.
  viewportLines: seedFromConfig("editor.viewportLines", 50) as number,
  maxRetries: seedFromConfig("editor.maxRetries", 3) as number,
  fuzzyThreshold: seedFromConfig("editor.fuzzyThreshold", 0.85) as number,
  syntaxValidationEnabled: seedFromConfig("editor.syntaxValidationEnabled", true) as boolean,
  atomicWriteEnabled: seedFromConfig("editor.atomicWriteEnabled", true) as boolean,
  feedbackLoopEnabled: seedFromConfig("editor.feedbackLoopEnabled", false) as boolean,
  historyRetention: seedFromConfig("editor.historyRetention", 100) as number,
  backupOnEdit: seedFromConfig("editor.backupOnEdit", true) as boolean,
  // The single-edit-tool pipeline knobs. `unifiedEditEnabled` gates whether the
  // `edit` tool is exposed to the model at all; `healCascadeEnabled` gates
  // whether a drifted oldString auto-heals; `jsonRepairEnabled` gates the
  // transport-level tool-argument repair.
  unifiedEditEnabled: seedFromConfig("editor.unifiedEditEnabled", true) as boolean,
  healCascadeEnabled: seedFromConfig("editor.healCascadeEnabled", true) as boolean,
  jsonRepairEnabled: seedFromConfig("editor.jsonRepairEnabled", true) as boolean,
  /**
   * Retained pre-edit snapshots, oldest first, capped at `historyRetention`.
   * Each entry is one real edit's restore point: the file's bytes BEFORE the
   * edit landed ("" when the edit created the file — restoring it removes the
   * file). `editor.rollback` restores the newest entry through the governed
   * editor; with `backupOnEdit` off nothing is captured and there is nothing
   * to roll back to.
   */
  history: [] as Array<{
    repositoryRoot: string;
    path: string;
    previousContent: string;
    /** Whether the file existed before the edit (false = the edit created it). */
    existed: boolean;
    operation: string;
    strategy: string | null;
    outcome: "applied";
    at: number;
    /**
     * How much surrounding context the edit's preview carried (the
     * `viewportLines`-scaled figure the synthetic preview reports). Real
     * edits set it to the snapshot's own line count.
     */
    contextLines: number;
    /** How many hunks the edit described. */
    hunks: number;
  }>,
  /**
   * Why the previous edit failed. Replayed to the next edit only while
   * `feedbackLoopEnabled` is on — that is what "learn from edit results"
   * means here.
   */
  lastFailureReason: "",
  // Single-edit-tool telemetry. These count real events in the edit pipeline
  // (heal level used, JSON repair applied, refusals by category, rollbacks) so
  // the awareness/quality/learning modules and the UI read them as signals.
  healExactCount: 0,
  healWhitespaceCount: 0,
  healEscapeCount: 0,
  healFuzzyCount: 0,
  jsonRepairCount: 0,
  refusalCount: 0,
  wholeFileReplaceCount: 0,
  syntaxRefusalCount: 0,
};

/** State-field → config-path map (single source for the import-time seeds and the registration-time re-sync). */
const EDITOR_CONFIG_BINDINGS = {
  viewportLines: "editor.viewportLines",
  maxRetries: "editor.maxRetries",
  fuzzyThreshold: "editor.fuzzyThreshold",
  syntaxValidationEnabled: "editor.syntaxValidationEnabled",
  atomicWriteEnabled: "editor.atomicWriteEnabled",
  feedbackLoopEnabled: "editor.feedbackLoopEnabled",
  historyRetention: "editor.historyRetention",
  backupOnEdit: "editor.backupOnEdit",
  unifiedEditEnabled: "editor.unifiedEditEnabled",
  healCascadeEnabled: "editor.healCascadeEnabled",
  jsonRepairEnabled: "editor.jsonRepairEnabled",
} as const;

/** The outcome of a snapshot restore: restored, or an honest refusal reason. */
type RestoreOutcome =
  | Readonly<{ restored: true }>
  | Readonly<{ restored: false; reason: string }>;

/**
 * Restore one retained snapshot: write the file's pre-edit bytes back through
 * a governed whole-file write (the transactional editor's own syntax gate,
 * atomic write, post-write verification, and rollback — never a bare write).
 * The snapshot carries the root of the edit that produced it, so the restore
 * lands exactly where the edit did. A refusal (path no longer writable, the
 * restored content no longer parses, the write failed) is returned honestly —
 * never reported as a restore that did not happen.
 */
async function restoreSnapshot(
  snapshot: Readonly<{
    repositoryRoot: string;
    path: string;
    previousContent: string;
    existed: boolean;
  }>,
): Promise<RestoreOutcome> {
  // Lazy so the exposure catalog stays importable without the editor package
  // (the engine CLI loads the catalog before it has a repository root).
  const { createTransactionalEditor } = await import("../../../editor/transactional-editor.ts");
  const { sha256 } = await import("../../../kernel/integrity.ts");
  const { unlinkSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  // A synthetic preview pushed no real file state — its snapshot exists so the
  // retention knobs behave like the real path, never to be undone. Refuse to
  // "restore" it rather than write bytes to a path that was never edited.
  if (snapshot.repositoryRoot === "") {
    return { restored: false, reason: "the most recent history entry is a preview, not a file edit — there is nothing on disk to restore" };
  }
  // A create's snapshot: the file did not exist before the edit, so restoring
  // removes it (never a truncation to "" — an emptied file is not the state
  // the edit started from).
  if (!snapshot.existed) {
    try {
      const target = join(snapshot.repositoryRoot, snapshot.path);
      if (existsSync(target)) unlinkSync(target);
      return { restored: true };
    } catch (error) {
      return { restored: false, reason: `could not remove the created file: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const { readFileSync } = await import("node:fs");
  const editor = createTransactionalEditor({
    repositoryRoot: snapshot.repositoryRoot,
    writeSet: new Set([snapshot.path]),
    skipUnknownExtensions: true,
  });
  let current: string;
  try {
    current = readFileSync(join(snapshot.repositoryRoot, snapshot.path), "utf8");
  } catch {
    return { restored: false, reason: `the file "${snapshot.path}" no longer exists to restore` };
  }
  const result = editor.applyEdit({
    path: snapshot.path,
    preimageHash: sha256(current),
    operation: { kind: "replaceFile", newContent: snapshot.previousContent },
  });
  if (!result.success) {
    const reason = result.feedback?.message ?? "the restore write failed";
    return { restored: false, reason };
  }
  return { restored: true };
}

let editorRegistered = false;
export function registerEditorExposure(): void {
  if (editorRegistered) return;
  editorRegistered = true;
  // Re-seed the knob projection from the config file now that the config store
  // is installed (`registerAllExposure` installs it before this runs).
  syncStateFromConfig(editorState, EDITOR_CONFIG_BINDINGS);

  // The CATEGORY this module's settings live under, in the product's own
  // words — declared here, beside the entries it names, so every surface
  // derives the same grouping instead of authoring a namespace→name table.
  registerExposureModule({
    id: "editor",
    title: "Changing your files",
    purpose:
      "How edits reach your files: how exactly a change has to match, whether the result is checked afterwards, and how many past edits stay undoable.",
  });

  // --- Signals (10) ---
  registerSignal({
    id: "editor.editCount",
    module: "editor",
    name: "Edit Count",
    description: "Total number of edit operations submitted.",
    type: "counter",
    unit: "count",
    value: () => editorState.editCount,
  });
  registerSignal({
    id: "editor.successRate",
    module: "editor",
    name: "Success Rate",
    description: "Fraction of submitted edits that applied cleanly (0..1).",
    type: "gauge",
    unit: "ratio",
    value: () =>
      editorState.editCount === 0
        ? 0
        : editorState.successCount / editorState.editCount,
  });
  registerSignal({
    id: "editor.failureCount",
    module: "editor",
    name: "Failure Count",
    description: "Total number of edits that failed validation or application.",
    type: "counter",
    unit: "count",
    value: () => editorState.failureCount,
  });
  registerSignal({
    id: "editor.autoHealTriggerRate",
    module: "editor",
    name: "Auto-Heal Trigger Rate",
    description: "Fraction of edits that triggered automatic syntax healing (0..1).",
    type: "gauge",
    unit: "ratio",
    value: () =>
      editorState.editCount === 0
        ? 0
        : editorState.autoHealTriggerCount / editorState.editCount,
  });
  registerSignal({
    id: "editor.rollbackRate",
    module: "editor",
    name: "Rollback Rate",
    description: "Fraction of edits that were rolled back after application (0..1).",
    type: "gauge",
    unit: "ratio",
    value: () =>
      editorState.editCount === 0
        ? 0
        : editorState.rollbackCount / editorState.editCount,
  });
  registerSignal({
    id: "editor.totalEditsApplied",
    module: "editor",
    name: "Total Edits Applied",
    description: "Total number of individual edit hunks successfully applied.",
    type: "counter",
    unit: "count",
    value: () => editorState.totalEditsApplied,
  });
  registerSignal({
    id: "editor.lastEditAt",
    module: "editor",
    name: "Last Edit At",
    description: "Epoch-millisecond instant of the most recent edit.",
    // The value is `Date.now()` — an instant, not a duration. `timer`/`ms`
    // told renderers to format it as elapsed time (a ~56-year duration).
    type: "timestamp",
    unit: "epoch ms",
    value: () => editorState.lastEditAt,
  });
  registerSignal({
    id: "editor.atomicWriteEnabled",
    module: "editor",
    name: "Atomic Write Enabled",
    description: "Whether atomic write semantics are enforced on every edit.",
    type: "boolean",
    value: () => editorState.atomicWriteEnabled,
  });
  registerSignal({
    id: "editor.syntaxValidationEnabled",
    module: "editor",
    name: "Syntax Validation Enabled",
    description: "Whether post-edit syntax validation is enabled.",
    type: "boolean",
    value: () => editorState.syntaxValidationEnabled,
  });
  registerSignal({
    id: "editor.feedbackLoopEnabled",
    module: "editor",
    name: "Feedback Loop Enabled",
    description: "Whether the edit feedback loop (errors → next prompt) is enabled.",
    type: "boolean",
    value: () => editorState.feedbackLoopEnabled,
  });
  registerSignal({
    id: "editor.unifiedEditEnabled",
    module: "editor",
    name: "Single edit tool enabled",
    description: "Whether the single 'edit' tool is exposed to the model.",
    type: "boolean",
    value: () => editorState.unifiedEditEnabled,
  });
  registerSignal({
    id: "editor.healCascadeEnabled",
    module: "editor",
    name: "Auto-heal drifted edits",
    description: "Whether a slightly-off edit target is automatically matched to the file's real text.",
    type: "boolean",
    value: () => editorState.healCascadeEnabled,
  });
  registerSignal({
    id: "editor.jsonRepairEnabled",
    module: "editor",
    name: "Repair malformed tool-call JSON",
    description: "Whether malformed tool-call arguments from the model are repaired before running the tool.",
    type: "boolean",
    value: () => editorState.jsonRepairEnabled,
  });
  registerSignal({
    id: "editor.jsonRepairCount",
    module: "editor",
    name: "Repaired tool-call payloads",
    description: "How many malformed tool-call argument payloads were repaired before dispatch.",
    type: "counter",
    unit: "count",
    value: () => editorState.jsonRepairCount,
  });
  registerSignal({
    id: "editor.refusalCount",
    module: "editor",
    name: "Refused edits",
    description: "How many edits were refused (ambiguous, not found, or invalid) rather than applied.",
    type: "counter",
    unit: "count",
    value: () => editorState.refusalCount,
  });
  registerSignal({
    id: "editor.healTriggerCount",
    module: "editor",
    name: "Healed edits",
    description: "How many edits needed a heal level (whitespace, escape, or fuzzy) to match the file.",
    type: "counter",
    unit: "count",
    value: () => editorState.healWhitespaceCount + editorState.healEscapeCount + editorState.healFuzzyCount,
  });

  // --- Actions (5) ---
  registerAction({
    id: "editor.rollback",
    module: "editor",
    name: "Rollback",
    description: "Roll back the most recent edit transaction, restoring its retained snapshot.",
    // A rollback restores a SNAPSHOT: the bytes the file held BEFORE the most
    // recent edit. With `backupOnEdit` off none is taken, so there is nothing
    // to restore and the rollback honestly refuses rather than reporting a
    // restore that did not happen. `historyRetention` bounds how far back
    // rollbacks can reach. The restore goes through a governed whole-file
    // write — same syntax gate, atomic write, and post-write verification the
    // edit itself passed through — so a rollback cannot land corrupt bytes
    // either.
    execute: async () => {
      const snapshot = editorState.history.pop();
      if (snapshot === undefined) {
        return {
          rolledBack: false,
          reason: "no retained snapshot to restore",
          historyDepth: 0,
          rollbackCount: editorState.rollbackCount,
        };
      }
      const outcome = await restoreSnapshot(snapshot);
      if (!outcome.restored) {
        // The restore was refused — the snapshot is lost either way, so say
        // plainly that nothing was restored rather than pretending.
        editorState.failureCount += 1;
        editorState.lastFailureReason = outcome.reason;
        return {
          rolledBack: false,
          reason: outcome.reason,
          historyDepth: editorState.history.length,
          rollbackCount: editorState.rollbackCount,
        };
      }
      editorState.rollbackCount += 1;
      return {
        rolledBack: true,
        path: snapshot.path,
        restoredBytes: Buffer.byteLength(snapshot.previousContent, "utf8"),
        restoredLines: snapshot.contextLines,
        restoredHunks: snapshot.hunks,
        historyDepth: editorState.history.length,
        rollbackCount: editorState.rollbackCount,
      };
    },
  });
  registerAction({
    id: "editor.clearHistory",
    module: "editor",
    name: "Clear History",
    description: "Drop all retained edit history.",
    execute: async () => {
      editorState.editCount = 0;
      editorState.successCount = 0;
      editorState.failureCount = 0;
      editorState.rollbackCount = 0;
      editorState.autoHealTriggerCount = 0;
      editorState.totalEditsApplied = 0;
      editorState.lastEditAt = 0;
      editorState.history.length = 0;
      editorState.lastFailureReason = "";
      return { cleared: true };
    },
  });
  registerAction({
    id: "editor.applyEdit",
    module: "editor",
    name: "Apply Edit",
    description: "Submit a synthetic edit through the editor's real placement, retry, backup and validation path.",
    args: {
      hunks: { type: "number", required: false, description: "Number of hunks to apply" },
      succeed: { type: "boolean", required: false, description: "Force success/failure" },
      autoHeal: { type: "boolean", required: false, description: "Force auto-heal trigger" },
      matchScore: {
        type: "number",
        required: false,
        description: "How closely the text this edit targets matched the file (0..1), judged against `editor.fuzzyThreshold`",
      },
      failAttempts: {
        type: "number",
        required: false,
        description: "How many attempts fail before the write lands; more than `editor.maxRetries` means the edit gives up",
      },
      partialHunks: {
        type: "number",
        required: false,
        description: "Hunks already written when the failure hit; retained only when `editor.atomicWriteEnabled` is off",
      },
      syntaxOk: {
        type: "boolean",
        required: false,
        description: "Whether the post-edit file parses; only checked when `editor.syntaxValidationEnabled` is on",
      },
    },
    // Every knob this module exposes is read HERE, at call time, from the
    // module's own state — which is what makes `effect: "immediate"` true of
    // each of them. Values the module cannot know (how well the target text
    // matched, how many attempts the underlying write needs, whether the
    // result parses) are STATED by the caller and defaulted to the benign
    // case; nothing about the outcome is invented.
    execute: async (args) => {
      const hunks = Number(args?.hunks ?? 1);
      editorState.editCount += 1;
      editorState.lastEditAt = Date.now();
      // Replay the previous failure only while the feedback loop is on.
      const priorFailure = editorState.feedbackLoopEnabled ? editorState.lastFailureReason : "";
      const fail = (reason: string, extra: Record<string, unknown>): Record<string, unknown> => {
        editorState.failureCount += 1;
        editorState.lastFailureReason = reason;
        return { applied: false, reason, editCount: editorState.editCount, hunks, priorFailure, ...extra };
      };

      // 1. PLACEMENT — `fuzzyThreshold` is the strictness the target text must
      //    meet. Below it the editor cannot say where the edit goes, so no
      //    attempt (and no backup) is made at all.
      const matchScore = args?.matchScore === undefined ? 1 : Number(args.matchScore);
      if (matchScore < editorState.fuzzyThreshold) {
        return fail("match below edit-match strictness", {
          matchScore,
          fuzzyThreshold: editorState.fuzzyThreshold,
          attempts: 0,
        });
      }

      // 2. BACKUP — `backupOnEdit` decides whether a snapshot is captured at
      //    all; `viewportLines` decides how much context each hunk's snapshot
      //    holds; `historyRetention` caps how many snapshots survive. This is
      //    a synthetic preview (no file is edited), so its snapshot carries a
      //    sentinel root that `editor.rollback` never restores — the entry
      //    exists so the retention/depth knobs behave identically to the real
      //    path, not to be undone.
      const contextLines = hunks * editorState.viewportLines;
      const backedUp = editorState.backupOnEdit;
      if (backedUp) {
        editorState.history.push({
          repositoryRoot: "",
          path: "(synthetic preview — no file)",
          previousContent: "",
          existed: true,
          operation: "preview",
          strategy: null,
          outcome: "applied",
          at: editorState.lastEditAt,
          contextLines,
          hunks,
        });
        while (editorState.history.length > editorState.historyRetention) {
          editorState.history.shift();
        }
      }

      // 3. RETRY — `maxRetries` is how many further attempts a failing write
      //    gets. `succeed: false` states that every attempt fails.
      const forcedFailure = args?.succeed === false;
      const failAttempts = forcedFailure
        ? Number.POSITIVE_INFINITY
        : Math.max(0, Number(args?.failAttempts ?? 0));
      const retries = Math.min(failAttempts, editorState.maxRetries);
      const attempts = retries + 1;
      const wrote = failAttempts <= editorState.maxRetries;
      if (args?.autoHeal === true) editorState.autoHealTriggerCount += 1;
      if (!wrote) {
        // 4. ATOMICITY — an all-or-nothing save leaves the file untouched;
        //    with it off, the hunks that already landed stay landed.
        const retained = editorState.atomicWriteEnabled ? 0 : Math.max(0, Number(args?.partialHunks ?? 0));
        editorState.totalEditsApplied += retained;
        return fail("write failed after every retry", {
          attempts,
          retries,
          maxRetries: editorState.maxRetries,
          backedUp,
          contextLines,
          historyDepth: editorState.history.length,
          retainedHunks: retained,
        });
      }

      // 5. VALIDATION — when syntax validation is on, an edit that leaves the
      //    file unparsable does not count as done and triggers healing.
      if (editorState.syntaxValidationEnabled && args?.syntaxOk === false) {
        editorState.autoHealTriggerCount += 1;
        const retained = editorState.atomicWriteEnabled ? 0 : hunks;
        editorState.totalEditsApplied += retained;
        return fail("post-edit syntax validation failed", {
          attempts,
          retries,
          backedUp,
          contextLines,
          historyDepth: editorState.history.length,
          retainedHunks: retained,
          syntaxChecked: true,
        });
      }

      editorState.successCount += 1;
      editorState.totalEditsApplied += hunks;
      editorState.lastFailureReason = "";
      return {
        applied: true,
        editCount: editorState.editCount,
        hunks,
        succeed: true,
        attempts,
        retries,
        backedUp,
        contextLines,
        historyDepth: editorState.history.length,
        syntaxChecked: editorState.syntaxValidationEnabled,
        priorFailure,
      };
    },
  });
  registerAction({
    id: "editor.validateSyntax",
    module: "editor",
    name: "Validate Syntax",
    description: "Run a syntax validation pass over a synthetic snippet.",
    args: {
      ok: { type: "boolean", required: false, description: "Force pass/fail" },
    },
    execute: async (args) => {
      const ok = args?.ok === undefined ? true : Boolean(args?.ok);
      if (!ok) editorState.failureCount += 1;
      return { ok };
    },
  });
  registerAction({
    id: "editor.resetStats",
    module: "editor",
    name: "Reset Stats",
    description: "Reset only the editor's statistical counters (history preserved).",
    execute: async () => {
      editorState.successCount = 0;
      editorState.failureCount = 0;
      editorState.rollbackCount = 0;
      editorState.autoHealTriggerCount = 0;
      editorState.totalEditsApplied = 0;
      return { reset: true };
    },
  });

  // --- Customizations (8) ---
  // Effect timing: all eight are read by `applyEdit`/`rollback` at call time
  // (placement, backup, retry, atomicity, validation, feedback — see the
  // numbered steps above), so a change takes effect on the very next edit and
  // `effect: "immediate"` states exactly that. Verified behaviourally by
  // test/shared/exposure-customization-liveness.test.ts, not asserted from
  // the shape of the code.
  registerCustomization({
    id: "editor.viewportLines",
    module: "editor",
    name: "Lines of context around an edit",
    description:
      "How many lines around the edited spot are visible while a file is being changed. Higher = more surrounding context per edit.",
    type: "number",
    default: 50,
    min: 1,
    max: 1000,
    unit: "lines",
    current: () => editorState.viewportLines,
    set: configBoundSet("editor.viewportLines", (v) => { editorState.viewportLines = Number(v); }),
    contract: { effect: "immediate" },
    configPath: "editor.viewportLines",
  });
  registerCustomization({
    id: "editor.maxRetries",
    module: "editor",
    name: "Retries after a failed edit",
    description:
      "How many times a failed file edit is attempted again before giving up.",
    type: "number",
    default: 3,
    min: 0,
    max: 20,
    unit: "retries",
    current: () => editorState.maxRetries,
    set: configBoundSet("editor.maxRetries", (v) => { editorState.maxRetries = Number(v); }),
    contract: { effect: "immediate" },
    configPath: "editor.maxRetries",
  });
  registerCustomization({
    id: "editor.fuzzyThreshold",
    module: "editor",
    name: "Edit-match strictness",
    description:
      "How closely the text an edit wants to replace must match what is actually in the file (0..1). Lower = more forgiving, with more risk of editing the wrong spot.",
    type: "number",
    default: 0.85,
    min: 0,
    max: 1,
    unit: "score",
    current: () => editorState.fuzzyThreshold,
    set: configBoundSet("editor.fuzzyThreshold", (v) => { editorState.fuzzyThreshold = Number(v); }),
    contract: { effect: "immediate" },
    configPath: "editor.fuzzyThreshold",
  });
  registerCustomization({
    id: "editor.syntaxValidationEnabled",
    module: "editor",
    name: "Check code for errors after edits",
    description:
      "On: after each edit, the file is checked for syntax errors before the edit counts as done.",
    type: "boolean",
    default: true,
    current: () => editorState.syntaxValidationEnabled,
    set: configBoundSet("editor.syntaxValidationEnabled", (v) => { editorState.syntaxValidationEnabled = Boolean(v); }),
    contract: { effect: "immediate" },
    configPath: "editor.syntaxValidationEnabled",
    measuredBy: "editor.syntaxValidationEnabled",
  });
  registerCustomization({
    id: "editor.atomicWriteEnabled",
    module: "editor",
    name: "All-or-nothing file saves",
    description:
      "On: a file save either fully completes or leaves the file untouched — an interruption mid-save cannot corrupt it.",
    type: "boolean",
    default: true,
    current: () => editorState.atomicWriteEnabled,
    set: configBoundSet("editor.atomicWriteEnabled", (v) => { editorState.atomicWriteEnabled = Boolean(v); }),
    contract: { effect: "immediate" },
    configPath: "editor.atomicWriteEnabled",
    measuredBy: "editor.atomicWriteEnabled",
  });
  registerCustomization({
    id: "editor.feedbackLoopEnabled",
    module: "editor",
    name: "Learn from edit results",
    description:
      "On: the outcome of each edit is fed back to improve later edits.",
    type: "boolean",
    default: false,
    current: () => editorState.feedbackLoopEnabled,
    set: configBoundSet("editor.feedbackLoopEnabled", (v) => { editorState.feedbackLoopEnabled = Boolean(v); }),
    contract: { effect: "immediate" },
    configPath: "editor.feedbackLoopEnabled",
    measuredBy: "editor.feedbackLoopEnabled",
  });
  registerCustomization({
    id: "editor.historyRetention",
    module: "editor",
    name: "Edits kept in history",
    description:
      "How many past edits are kept and can be looked back on. Older edits beyond this are dropped.",
    type: "number",
    default: 100,
    min: 0,
    max: 10000,
    unit: "edits",
    current: () => editorState.historyRetention,
    set: configBoundSet("editor.historyRetention", (v) => {
      editorState.historyRetention = Number(v);
      // A lowered retention applies immediately: the oldest snapshots beyond
      // it are dropped now, not at the next edit.
      while (editorState.history.length > editorState.historyRetention) {
        editorState.history.shift();
      }
    }),
    contract: { effect: "immediate" },
    configPath: "editor.historyRetention",
  });
  registerCustomization({
    id: "editor.backupOnEdit",
    module: "editor",
    name: "Back up before every edit",
    description:
      "On: a snapshot of the file is saved before each edit, so the previous state can be restored.",
    type: "boolean",
    default: true,
    current: () => editorState.backupOnEdit,
    set: configBoundSet("editor.backupOnEdit", (v) => { editorState.backupOnEdit = Boolean(v); }),
    contract: { effect: "immediate" },
    configPath: "editor.backupOnEdit",
  });
  registerCustomization({
    id: "editor.unifiedEditEnabled",
    module: "editor",
    name: "Use the single edit tool",
    description:
      "On: the model is offered one 'edit' tool that replaces, inserts, deletes, creates, and rewrites files by matching exact text. Off: no file-editing tool is exposed.",
    type: "boolean",
    default: true,
    current: () => editorState.unifiedEditEnabled,
    set: configBoundSet("editor.unifiedEditEnabled", (v) => { editorState.unifiedEditEnabled = Boolean(v); }),
    contract: { effect: "immediate" },
    configPath: "editor.unifiedEditEnabled",
    measuredBy: "editor.unifiedEditEnabled",
  });
  registerCustomization({
    id: "editor.healCascadeEnabled",
    module: "editor",
    name: "Auto-heal slightly-off edits",
    description:
      "On: when the text an edit wants to replace is slightly off (whitespace, escapes, or a small drift), it is matched to the file's real text automatically. Off: the edit must match exactly or it is refused.",
    type: "boolean",
    default: true,
    current: () => editorState.healCascadeEnabled,
    set: configBoundSet("editor.healCascadeEnabled", (v) => { editorState.healCascadeEnabled = Boolean(v); }),
    contract: { effect: "immediate" },
    configPath: "editor.healCascadeEnabled",
    measuredBy: "editor.healCascadeEnabled",
  });
  registerCustomization({
    id: "editor.jsonRepairEnabled",
    module: "editor",
    name: "Repair malformed tool-call JSON",
    description:
      "On: a tool call whose arguments are almost-JSON (a stray fence, an unclosed brace, a trailing comma) is repaired before the tool runs. Off: malformed arguments fail the call.",
    type: "boolean",
    default: true,
    current: () => editorState.jsonRepairEnabled,
    set: configBoundSet("editor.jsonRepairEnabled", (v) => { editorState.jsonRepairEnabled = Boolean(v); }),
    contract: { effect: "immediate" },
    configPath: "editor.jsonRepairEnabled",
    measuredBy: "editor.jsonRepairEnabled",
  });
}

/** Reset the per-module registration flag (test-only). */
export function resetEditorRegistration(): void {
  editorRegistered = false;
}
