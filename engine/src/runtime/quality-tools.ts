import { readFileSync } from "node:fs";
import { join, isAbsolute, relative } from "node:path";

import { InputError, SecurityError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import { generateRepositoryMap } from "../intelligence/repository-map.ts";
import type { RepositoryMap } from "../intelligence/intelligence-types.ts";
import { relativePathViolationKinds } from "../filesystem/path-boundary.ts";
import {
  createQualityPackRegistry,
  runQualityPack,
  type QualityContext,
  type QualityPackRegistry,
  QUALITY_MAX_FILE_BYTES,
} from "../quality-packs/quality-pack.ts";
import { typescriptPack } from "../quality-packs/typescript-pack.ts";
import type { RegisteredTool, ToolContext } from "./tool-registry.ts";
import { handleError } from "../shared/debug/debug-system.ts";
import { QUALITY_MAX_FILES as MAX_FILES } from "./runtime-config.ts";

/**
 * Quality tool for the interactive chat runtime (delivery-map item 9).
 *
 * Exposes `run_quality_check` so the model can run the applicable language
 * quality packs over a set of files (or the whole repository) and receive a
 * normalized diagnostic report. The packs reuse existing infrastructure
 * (Babel syntax validator, symbol extractor, architecture manifest) so no
 * competing tools are introduced.
 *
 * The registry is seeded with the TypeScript pack. Additional packs can be
 * registered through the extension lifecycle (delivery-map item 12), not
 * here — this module is the runtime consumer, not the pack authority.
 *
 * Per the quality-pack contract, results are deterministic diagnostics. A
 * `tool-error` status surfaces a typed blocker rather than a silent pass.
 */

export type QualityToolsOptions = Readonly<{
  repositoryRoot: string;
  registry?: QualityPackRegistry;
  /**
   * Optional repository-map provider for tests. Production leaves this
   * undefined so the real {@link generateRepositoryMap} is used. The returned
   * map is cached for the session (MINOR-7).
   */
  mapProvider?: () => RepositoryMap;
  /**
   * Optional allowlist of quality-pack IDs to register (delivery-map item 9
   * / REQ-015). When provided and non-empty, only packs whose `id` is in the
   * list are registered. When absent or empty, the runtime defaults to the
   * TypeScript pack (backwards compat). Sourced from the central config
   * document's `qualityPacks.enabled` field.
   */
  enabledPacks?: readonly string[];
}>;

/**
 * Reusable quality-check runner (FIX 8). Encapsulates the registry, the
 * cached repository map, and the file-reading bounds so both the
 * `run_quality_check` tool and the post-edit auto-run hook share one
 * implementation (DRY). The runner is a pure function of its inputs: the
 * same files + registry produce the same diagnostics.
 */
export type QualityCheckRunner = Readonly<{
  runOnFiles(files: readonly string[]): QualityCheckReport;
}>;

export type QualityCheckReport = Readonly<{
  packsRun: number;
  results: readonly Readonly<{
    packId: string;
    exitCode: number;
    summary: unknown;
    checkResults: readonly Readonly<{
      checkId: string;
      status: string;
      message: string | null;
      diagnostics: readonly unknown[];
    }>[];
  }>[];
  message?: string;
}>;

const MAX_FILE_BYTES = QUALITY_MAX_FILE_BYTES;

function createQualityCheckRunner(options: {
  repositoryRoot: string;
  registry?: QualityPackRegistry;
  enabledPacks?: readonly string[];
  mapProvider?: () => RepositoryMap;
}): QualityCheckRunner {
  const repositoryRoot = options.repositoryRoot;
  const registry = options.registry ?? createDefaultQualityRegistry(options.enabledPacks);
  let cachedMap: RepositoryMap | undefined;
  function getRepositoryMap(): RepositoryMap {
    if (cachedMap === undefined) {
      cachedMap = options.mapProvider !== undefined
        ? options.mapProvider()
        : generateRepositoryMap(repositoryRoot).map;
    }
    return cachedMap;
  }
  function runOnFiles(files: readonly string[]): QualityCheckReport {
    const fileMap: Readonly<Record<string, string>> = files.length === 0
      ? readAllSourceFiles(repositoryRoot, getRepositoryMap)
      : readExplicitFiles(repositoryRoot, files);
    const applicable = registry.resolveForFiles(fileMap);
    if (applicable.length === 0) {
      return deepFreeze({ packsRun: 0, results: [], message: "No quality pack is applicable to the requested files" });
    }
    const context: QualityContext = deepFreeze({
      filePath: null,
      source: null,
      rootPath: repositoryRoot,
      files: fileMap,
      config: deepFreeze({}),
    });
    const results = applicable.map((pack) => runQualityPack(pack, context));
    return deepFreeze({
      packsRun: results.length,
      results: results.map((r) => deepFreeze({
        packId: r.packId,
        exitCode: r.exitCode,
        summary: r.summary,
        checkResults: r.checkResults.map((c) => deepFreeze({
          checkId: c.checkId,
          status: c.status,
          message: c.message,
          diagnostics: c.diagnostics,
        })),
      })),
    });
  }
  return deepFreeze({ runOnFiles });
}

function readExplicitFiles(
  repositoryRoot: string,
  files: readonly string[],
): Readonly<Record<string, string>> {
  if (files.length > MAX_FILES) {
    throw new InputError(`files exceed maximum of ${MAX_FILES}`, "tool_argument_oversized");
  }
  const out: Record<string, string> = {};
  for (const entry of files) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new InputError("each file path must be a non-empty string", "tool_arguments_invalid");
    }
    const resolved = resolveSafePath(entry, repositoryRoot);
    out[entry] = readBoundedFile(resolved);
  }
  return deepFreeze(out);
}

function resolveSafePath(input: string, repositoryRoot: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new InputError("path must be a non-empty string", "tool_arguments_invalid");
  }
  const normalized = input;
  const violations = relativePathViolationKinds(normalized);
  if (violations.length > 0) {
    throw new SecurityError("path is not a safe relative path", "tool_path_invalid");
  }
  const resolved = join(repositoryRoot, normalized);
  const rel = relative(repositoryRoot, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new SecurityError("path escapes repository root", "tool_path_escape");
  }
  return resolved;
}

export function createQualityTools(options: QualityToolsOptions): readonly RegisteredTool[] {
  const repositoryRoot = options.repositoryRoot;
  const runner: QualityCheckRunner = createQualityCheckRunner({
    repositoryRoot,
    ...(options.registry !== undefined ? { registry: options.registry } : {}),
    ...(options.enabledPacks !== undefined ? { enabledPacks: options.enabledPacks } : {}),
    ...(options.mapProvider !== undefined ? { mapProvider: options.mapProvider } : {}),
  });

  const runQualityCheck: RegisteredTool = deepFreeze({
    definition: deepFreeze({
      type: "function",
      function: deepFreeze({
        name: "run_quality_check",
        description: "Run applicable language quality packs over a set of files (or the whole repository when files is omitted). Returns a normalized diagnostic report covering syntax, type, undefined-symbol, dead-code, dead-branch, unused-export, duplicate-logic, schema-drift, and config-outside-contract categories. Use this after edits to verify quality (REQ-015).",
        parameters: deepFreeze({
          type: "object",
          properties: deepFreeze({
            files: {
              type: "array",
              items: { type: "string" },
              description: "Repository-relative file paths to check. Omit to check all source files in the repository (bounded).",
            },
          }),
          required: [],
          additionalProperties: false,
        }),
      }),
    }),
    handler(args: Readonly<Record<string, unknown>>, _context: ToolContext): string {
      const requested = args.files;
      const files = Array.isArray(requested)
        ? requested.filter((f): f is string => typeof f === "string" && f.length > 0)
        : [];
      const report = runner.runOnFiles(files);
      return JSON.stringify(report);
    },
  });

  return deepFreeze([runQualityCheck]);
}

function createDefaultQualityRegistry(enabledPacks?: readonly string[]): QualityPackRegistry {
  const registry = createQualityPackRegistry();
  // The set of known packs. Currently only typescript-pack is implemented;
  // additional packs are registered through the extension lifecycle
  // (delivery-map item 12). When `enabledPacks` is provided and non-empty,
  // only packs whose id is in the list are registered. When absent or empty,
  // default to the TypeScript pack (backwards compat).
  const knownPacks: readonly Readonly<{ id: string; pack: typeof typescriptPack }>[] = [
    { id: typescriptPack.id, pack: typescriptPack },
  ];
  const allow = enabledPacks !== undefined && enabledPacks.length > 0
    ? new Set<string>(enabledPacks)
    : undefined;
  for (const { id, pack } of knownPacks) {
    if (allow !== undefined && !allow.has(id)) continue;
    registry.register(pack);
  }
  return registry;
}

function readBoundedFile(resolved: string): string {
  const bytes = readFileSync(resolved);
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new InputError("file exceeds maximum read size for quality check", "tool_file_oversized");
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function readAllSourceFiles(
  repositoryRoot: string,
  mapProvider: () => RepositoryMap,
): Readonly<Record<string, string>> {
  const map = mapProvider();
  const files: Record<string, string> = {};
  let count = 0;
  for (const file of map.files) {
    if (count >= MAX_FILES) break;
    if (file.sizeBytes > MAX_FILE_BYTES) continue;
    try {
      const resolved = join(repositoryRoot, file.path);
      files[file.path] = readBoundedFile(resolved);
      count += 1;
    } catch (e) {handleError(e, { module: "runtime-quality-tools", operation: "catch" });
      continue;
    }
  }
  return deepFreeze(files);
}
