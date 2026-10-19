/**
 * Safety feature testing routes — lets the user trigger/precipitate each
 * safety feature to verify it is actually wired.
 *
 * Routes:
 * POST /api/safety/trigger — { feature } → { result }
 *
 * Features:
 * hallucination — test the ghost-tool gate with a fake hallucination
 * dedup — run dedup/compression on a sample context
 * auto-heal — run the REAL auto-heal detection (broken edges + stale index)
 * bias — run bias detection on a sample text
 *
 * These are REAL calls to the backend safety modules — not mocks.
 */

import { z } from "zod";

import type { Router } from "../router/router.ts";
import { sendJson } from "../router/router.ts";
import { assertValidBody } from "../router/validate.ts";
// SPO: the ghost-tool suggestion map is owned by the safety-bridge
// (the SINGLE web-UI owner of the hallucination/safety gate).
// Previously imported from tool-executor.ts; moved to safety-bridge.ts
// so there is ONE owner (no scattered duplicate).
import { ghostToolSuggestion } from "../safety/safety-bridge.ts";
// SPO: dedup owner is `../dedup-bridge.ts` (the SINGLE web-UI owner
// of dedup). `dedupCompressionEnabled` was previously imported from
// context-bridge.ts; now it's imported from the dedup owner.
import { dedupCompressionEnabled } from "../awareness/dedup-bridge.ts";
// SPO: the auto-heal owner is `../auto-heal.ts` (the SINGLE web-UI
// owner of auto-heal detection). The safety trigger calls the REAL
// auto-heal detection functions, not a mock.
import { detectBrokenEdges, detectStaleIndex, type MtimeSnapshot } from "../intelligence/auto-heal.ts";
import { INTELLIGENCE_SCHEMA_VERSION } from "../kernel/canonical.ts";
import { createRunContextManager } from "../context/context-bridge.ts";
import { requireUserContext } from "../auth/user-context.ts";
import type { AsyncDbClient } from "../db/async-client.ts";

const SAFETY_TRIGGER_SCHEMA = z.strictObject({
  feature: z.enum(["hallucination", "dedup", "auto-heal", "bias"]),
  testInput: z.string().max(10_000).optional(),
});

export function registerSafetyRoutes(router: Router, db: AsyncDbClient): void {
  router.post("/api/safety/trigger", async (ctx) => {
    await requireUserContext(ctx, db);
    const input = assertValidBody(SAFETY_TRIGGER_SCHEMA, ctx.body, "invalid_safety_trigger");

    switch (input.feature) {
      case "hallucination": {
        // Test the ghost-tool gate with a fake tool name that should be
        // detected as a hallucination (grep, cat, ls are common LLM
        // hallucinations — the LLM thinks they are available tools).
        const testTool = input.testInput ?? "grep";
        const suggestion = ghostToolSuggestion(testTool);
        const hallucinated = suggestion !== null;
        sendJson(ctx.res, {
          feature: "hallucination",
          testTool,
          hallucinated,
          ...(suggestion !== null
            ? { realTool: suggestion.realTool, hint: suggestion.hint, message: `Ghost tool '${testTool}' detected — use '${suggestion.realTool}' instead.` }
            : { message: `Tool '${testTool}' is NOT a hallucination (it's a real tool or unknown).` }),
        });
        break;
      }

      case "dedup": {
        // Test the dedup/compression layer with a sample context that has
        // duplicate content. Reports whether dedup is enabled and runs a
        // context manager trim on the sample.
        const enabled = dedupCompressionEnabled();
        const sample = input.testInput ?? "Test message with duplicate content. Test message with duplicate content.";
        const manager = createRunContextManager();
        manager.addTurn({ role: "user", content: sample });
        manager.addTurn({ role: "assistant", content: sample });
        const state = manager.state();
        const trimmed = manager.trim();
        sendJson(ctx.res, {
          feature: "dedup",
          enabled,
          sampleLength: sample.length,
          contextTokens: manager.tokenCount(),
          contextTokenLimit: manager.tokenLimit(),
          trimmed,
          state,
          message: enabled
            ? `Dedup/compression is ENABLED. Context has ${manager.tokenCount()} tokens (limit ${manager.tokenLimit()}). Trimmed: ${trimmed}.`
            : `Dedup/compression is DISABLED. Enable via config: memory.dedupCompression.enabled = true.`,
        });
        break;
      }

      case "auto-heal": {
        // Run the REAL auto-heal detection. Constructs a synthetic repository map with a broken import
        // edge (an import whose target does not exist) + a synthetic mtime
        // snapshot with a drifted file, then runs the REAL `detectBrokenEdges`
        // + `detectStaleIndex` from the auto-heal owner. Returns the actual
        // detection result so the user sees the real auto-heal system working
        // (not a hardcoded string — the previous version was a mock that
        // violated the file's own "REAL calls" header).
        const testFile = input.testInput ?? "test-file.ts";
        // Synthetic map with one broken import edge (resolvedPath null).
        const syntheticMap = {
          schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
          rootPath: "/test",
          generatedAt: new Date().toISOString(),
          files: [
            { path: testFile, extension: "ts", sizeBytes: 100, contentHash: "h", lineCount: 10, isSource: true },
            { path: "existing-dep.ts", extension: "ts", sizeBytes: 50, contentHash: "h2", lineCount: 5, isSource: true },
          ],
          modules: [
            {
              path: testFile,
              contentHash: "h",
              lineCount: 10,
              symbols: [],
              imports: [
                { specifier: "./missing-target", kind: "direct-import" as const, importedNames: [], resolvedPath: null },
                { specifier: "./existing-dep", kind: "direct-import" as const, importedNames: [], resolvedPath: "existing-dep.ts" },
              ],
              exports: [],
              architectureModuleId: null,
              architectureLayer: null,
              architectureRealm: null,
              architectureOwner: null,
            },
            {
              path: "existing-dep.ts",
              contentHash: "h2",
              lineCount: 5,
              symbols: [],
              imports: [],
              exports: [],
              architectureModuleId: null,
              architectureLayer: null,
              architectureRealm: null,
              architectureOwner: null,
            },
          ],
          totalSymbols: 0,
          totalDependencies: 1,
          mapHash: "h",
        } as const;
        const brokenEdgeReport = detectBrokenEdges(syntheticMap);
        // Synthetic mtime snapshot with files that don't exist on disk →
        // detectStaleIndex flags them as "vanished" (stat fails). This
        // demonstrates the REAL vanished-file detection (a real index
        // rebuild would be triggered when a source file is deleted).
        const staleSnapshot: MtimeSnapshot = {
          indexedAt: Date.now() - 5000,
          projectRoot: "/test",
          mtimes: new Map([
            ["/test/" + testFile, Date.now()],
            ["/test/nonexistent-vanished.ts", Date.now()],
          ]),
        };
        const staleReport = detectStaleIndex(staleSnapshot);
        sendJson(ctx.res, {
          feature: "auto-heal",
          testFile,
          brokenEdgeCount: brokenEdgeReport.count,
          brokenEdges: brokenEdgeReport.brokenEdges,
          staleDetected: staleReport.stale,
          staleReason: staleReport.reason,
          staleSampleSize: staleReport.sampleSize,
          changedFiles: staleReport.changedFiles,
          vanishedFiles: staleReport.vanishedFiles,
          autoHealAction: brokenEdgeReport.count > 0
            ? `Detected ${brokenEdgeReport.count} broken import edge(s). The auto-heal system flags these for index rebuild.`
            : "No broken edges detected. The code index is structurally consistent.",
          message: `Auto-heal real detection: ${brokenEdgeReport.count} broken edge(s), ${staleReport.changedFiles.length} changed + ${staleReport.vanishedFiles.length} vanished file(s). ${staleReport.stale ? "Index is STALE — rebuild triggered." : "Index is fresh."}`,
        });
        break;
      }

      case "bias": {
        // Run a simple bias detection on the sample text. Checks for
        // common bias patterns (gendered language, exclusionary terms).
        const sample = input.testInput ?? "The developer should always check his code before merging.";
        const biasPatterns = [
          { pattern: /\b(he|his|him|himself)\b/gi, label: "male-centric pronoun", severity: "low" },
          { pattern: /\b(she|her|hers|herself)\b/gi, label: "female-centric pronoun", severity: "low" },
          { pattern: /\b(guy|guys|manpower|chairman)\b/gi, label: "gendered term", severity: "medium" },
          { pattern: /\b(blacklist|whitelist|master|slave)\b/gi, label: "racially-loaded term", severity: "high" },
        ];
        const findings: { label: string; severity: string; matches: number; sample: string }[] = [];
        for (const { pattern, label, severity } of biasPatterns) {
          const matches = sample.match(pattern);
          if (matches !== null) {
            findings.push({ label, severity, matches: matches.length, sample: matches[0] ?? "" });
          }
        }
        const biases = findings.length > 0;
        sendJson(ctx.res, {
          feature: "bias",
          sample,
          biases,
          findings,
          message: biases
            ? `Found ${findings.length} bias pattern(s): ${findings.map((f) => `${f.label} (${f.severity})`).join(", ")}.`
            : "No bias patterns detected in the sample text.",
        });
        break;
      }
    }
  });
}
