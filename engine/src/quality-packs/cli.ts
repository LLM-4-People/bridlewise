import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { InputError } from "../kernel/errors.ts";
import { canonicalJson, deepFreeze } from "../kernel/integrity.ts";
import { getExtension } from "../shared/path-utils.ts";
import {
  createQualityPackRegistry,
  type QualityContext,
  type QualityPackRegistry,
  QUALITY_MAX_FILE_BYTES,
} from "./quality-pack.ts";
import { typescriptPack } from "./typescript-pack.ts";
import { handleError } from "../shared/debug/debug-system.ts";
import {
  type QualityTier,
  getTierCheckIds,
  isQualityTier,
  runTier,
  type TierExecutionResult,
} from "./tiers.ts";
import { schemaId } from "../kernel/product-identity.ts";

/**
 * CLI handler for `node src/cli.ts quality [--tier=fast|incremental|full|holdout]`.
 *
 * Implements delivery map item 9: "deterministic quality enforcement,
 * reusable language quality packs, and hostile real-project tests."
 */

const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const DEFAULT_TIER: QualityTier = "full";
const MAX_FILE_BYTES = QUALITY_MAX_FILE_BYTES;
const MAX_FILE_COUNT = 10_000;

export async function runQualityCli(argv: readonly string[]): Promise<number> {
  const parsed = parseQualityArgs(argv);
  const registry = createQualityPackRegistryWithDefaults();
  const root = parsed.root ?? process.cwd();
  const files = collectSourceFiles(root, parsed.paths);
  const applicablePacks = registry.resolveForFiles(files);
  if (applicablePacks.length === 0) {
    process.stdout.write(`${canonicalJson({
      schemaVersion: schemaId("quality-cli", 1),
      tier: parsed.tier,
      status: "not-applicable",
      message: "No quality packs applicable to the detected files",
    })}\n`);
    return 0;
  }
  const context = createQualityContext(root, files);
  const result = runTier(parsed.tier, applicablePacks, context);
  const output = formatTierResult(result);
  process.stdout.write(`${canonicalJson(output)}\n`);
  return result.exitCode;
}

export type ParsedQualityArgs = Readonly<{
  tier: QualityTier;
  root: string | null;
  paths: readonly string[];
}>;

export function parseQualityArgs(argv: readonly string[]): ParsedQualityArgs {
  let tier: QualityTier = DEFAULT_TIER;
  let root: string | null = null;
  const paths: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--tier" || arg === "-t") {
      i += 1;
      const value = argv[i];
      if (value === undefined) {
        throw new InputError("--tier requires a value (fast|incremental|full|holdout)", "quality_tier_missing");
      }
      if (!isQualityTier(value)) {
        throw new InputError(
          `Invalid tier '${value}'. Must be one of: fast, incremental, full, holdout`,
          "quality_tier_invalid",
        );
      }
      tier = value;
    } else if (arg.startsWith("--tier=")) {
      const value = arg.slice("--tier=".length);
      if (!isQualityTier(value)) {
        throw new InputError(
          `Invalid tier '${value}'. Must be one of: fast, incremental, full, holdout`,
          "quality_tier_invalid",
        );
      }
      tier = value;
    } else if (arg === "--root" || arg === "-r") {
      i += 1;
      const value = argv[i];
      if (value === undefined) {
        throw new InputError("--root requires a path value", "quality_root_missing");
      }
      root = value;
    } else if (arg.startsWith("--root=")) {
      root = arg.slice("--root=".length);
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(`Usage: node src/cli.ts quality [--tier=fast|incremental|full|holdout] [--root=PATH] [file ...]\n`);
      process.exitCode = 0;
    } else if (!arg.startsWith("-")) {
      paths.push(arg);
    }
  }
  return deepFreeze({ tier, root, paths });
}

function createQualityPackRegistryWithDefaults(): QualityPackRegistry {
  const registry = createQualityPackRegistry();
  registry.register(typescriptPack);
  return registry;
}

export function createQualityContext(root: string, files: Readonly<Record<string, string>>): QualityContext {
  return deepFreeze({
    filePath: null,
    source: null,
    rootPath: root,
    files,
    config: {},
  });
}

export function collectSourceFiles(root: string, paths: readonly string[]): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  if (paths.length === 0) {
    collectFromDirectory(root, "", result, 0);
  } else {
    for (const path of paths) {
      const relativePath = path.startsWith("/") ? path.slice(1) : path;
      try {
        const full = join(root, relativePath);
        const content = readFileSync(full, "utf8");
        if (content.length <= MAX_FILE_BYTES) {
          result[relativePath] = content;
        }
      } catch (e) {handleError(e, { module: "quality-packs-cli", operation: "catch" });
        continue;
      }
    }
  }
  return deepFreeze(result);
}

function collectFromDirectory(root: string, dirPath: string, result: Record<string, string>, depth: number): void {
  if (depth > 16) return;
  if (Object.keys(result).length >= MAX_FILE_COUNT) return;
  let entries: string[];
  try {
    const dir = dirPath === "" ? root : join(root, dirPath);
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".git" || entry === "dist" || entry === "build" || entry === "coverage") continue;
    const relativeEntry = dirPath === "" ? entry : `${dirPath}/${entry}`;
    const fullEntry = join(root, relativeEntry);
    let isDir: boolean;
    try {
      const stats = statSync(fullEntry);
      isDir = stats.isDirectory();
      if (!isDir && SUPPORTED_EXTENSIONS.has(getExtension(entry))) {
        const content = readFileSync(fullEntry, "utf8");
        if (content.length <= MAX_FILE_BYTES) {
          result[relativeEntry] = content;
        }
      }
    } catch (e) {handleError(e, { module: "quality-packs-cli", operation: "catch" });
      continue;
    }
    if (isDir) {
      collectFromDirectory(root, relativeEntry, result, depth + 1);
    }
  }
}

export function formatTierResult(result: TierExecutionResult): Readonly<Record<string, unknown>> {
  return deepFreeze({
    schemaVersion: schemaId("quality-cli", 1),
    tier: result.tier,
    checkIds: getTierCheckIds(result.tier),
    summary: result.summary,
    exitCode: result.exitCode,
    packs: result.results.map((packResult) => ({
      packId: packResult.packId,
      summary: packResult.summary,
      checks: packResult.checkResults.map((check) => ({
        checkId: check.checkId,
        status: check.status,
        diagnosticCount: check.diagnostics.length,
        duration: check.duration,
        message: check.message,
      })),
    })),
  });
}
