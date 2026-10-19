import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { InputError } from "../../src/kernel/errors.ts";
import { canonicalJson, deepFreeze, sha256 } from "../../src/kernel/integrity.ts";
import { assertNoDuplicateJsonObjectKeys } from "../../src/kernel/json-integrity.ts";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";

export const REPOSITORY_PATH_UNICODE_GENERATOR_REVISION =
  "bridlewise-repository-path-unicode-generator/v1" as const;
export const REPOSITORY_PATH_UNICODE_DERIVATION_SCHEMA_VERSION =
  "bridlewise-repository-path-unicode-derivation/v2" as const;
export const REPOSITORY_PATH_SOURCE_AUTHORITY_CHECK_REVISION =
  "bridlewise-repository-path-source-authority-check/v1" as const;

const SHA256 = z.string().regex(/^[0-9a-f]{64}$/u);
const UNICODE_SOURCE_PATH = z.string().regex(
  /^traceability\/sources\/path-policy\/unicode-17\.0\.0\/[A-Za-z0-9.-]+$/u,
);
const SOURCE_ENTRY_SCHEMA = z.strictObject({
  id: z.string().min(1).max(128),
  role: z.string().min(1).max(128),
  path: UNICODE_SOURCE_PATH,
  url: z.string().url(),
  byteLength: z.number().int().positive().max(10_000_000),
  sha256: SHA256,
});
const SOURCE_MANIFEST_SCHEMA = z.strictObject({
  schemaVersion: z.literal("bridlewise-unicode-path-policy-sources/v1"),
  unicodeVersion: z.literal("17.0.0"),
  retrievedAt: z.string().datetime({ offset: true }),
  productionAuthority: z.strictObject({
    algorithm: z.literal("NFC(toCasefold(NFD(X)))"),
    caseFoldingStatuses: z.tuple([z.literal("C"), z.literal("F")]),
    expectedCaseFoldingEntries: z.literal(1_585),
    maximumCaseFoldingExpansionCodePoints: z.literal(3),
  }),
  license: z.strictObject({
    spdx: z.literal("Unicode-3.0"),
    path: UNICODE_SOURCE_PATH,
    url: z.string().url(),
    byteLength: z.number().int().positive().max(100_000),
    sha256: SHA256,
  }),
  sources: z.array(SOURCE_ENTRY_SCHEMA).length(3),
}).superRefine((manifest, context) => {
  const identifiers = manifest.sources.map((source) => source.id);
  const paths = [manifest.license.path, ...manifest.sources.map((source) => source.path)];
  if (new Set(identifiers).size !== identifiers.length) {
    context.addIssue({ code: "custom", message: "Unicode source identifiers must be unique" });
  }
  if (new Set(paths).size !== paths.length) {
    context.addIssue({ code: "custom", message: "Unicode source paths must be unique" });
  }
  for (const required of [
    "unicode-17.0.0-case-folding",
    "unicode-17.0.0-normalization-test",
    "unicode-17.0.0-ucd-readme",
  ]) {
    if (!identifiers.includes(required)) {
      context.addIssue({ code: "custom", message: `Required Unicode source is absent: ${required}` });
    }
  }
});

const PATH_POLICY_FILE_BINDING_SCHEMA = z.strictObject({
  path: z.string().regex(/^traceability\/sources\/path-policy\/[A-Za-z0-9./-]+$/u),
  byteLength: z.number().int().positive().max(10_000_000),
  sha256: SHA256,
});
const GIT_SOURCE_ENTRY_SCHEMA = PATH_POLICY_FILE_BINDING_SCHEMA.extend({
  id: z.string().min(1).max(128),
  role: z.string().min(1).max(128),
  upstreamPath: z.string().regex(/^[A-Za-z0-9./-]+$/u),
  url: z.string().url(),
});
const PATH_POLICY_SOURCE_MANIFEST_SCHEMA = z.strictObject({
  schemaVersion: z.literal("bridlewise-path-policy-sources/v1"),
  sourceSets: z.strictObject({
    unicode: z.strictObject({
      id: z.literal("unicode-17.0.0-path-portability"),
      role: z.literal("unicode-portability-source-manifest"),
      manifest: PATH_POLICY_FILE_BINDING_SCHEMA.extend({
        path: z.literal("traceability/sources/path-policy/unicode-17.0.0/manifest.json"),
      }),
    }),
    git: z.strictObject({
      id: z.string().min(1).max(128),
      role: z.literal("git-ntfs-symlink-alias-authority"),
      retrievedAt: z.string().datetime({ offset: true }),
      upstream: z.strictObject({
        repository: z.literal("https://github.com/git/git"),
        version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/u),
        tag: z.string().regex(/^v[0-9]+\.[0-9]+\.[0-9]+$/u),
        commit: z.string().regex(/^[0-9a-f]{40}$/u),
      }),
      license: PATH_POLICY_FILE_BINDING_SCHEMA.extend({
        spdx: z.literal("GPL-2.0-only"),
        url: z.string().url(),
      }),
      sources: z.array(GIT_SOURCE_ENTRY_SCHEMA).length(2),
    }),
  }),
}).superRefine((manifest, context) => {
  const git = manifest.sourceSets.git;
  const sourcePaths = [git.license.path, ...git.sources.map((source) => source.path)];
  const sourceIds = git.sources.map((source) => source.id);
  const root = `traceability/sources/path-policy/git-${git.upstream.version}/`;
  const rawRoot = `https://raw.githubusercontent.com/git/git/${git.upstream.tag}/`;
  if (git.upstream.tag !== `v${git.upstream.version}` ||
    git.id !== `git-${git.upstream.version}-ntfs-path-aliases`) {
    context.addIssue({ code: "custom", message: "Git version authority is inconsistent" });
  }
  if (new Set(sourcePaths).size !== sourcePaths.length || new Set(sourceIds).size !== sourceIds.length) {
    context.addIssue({ code: "custom", message: "Git source identities must be unique" });
  }
  if (git.license.path !== `${root}COPYING` || git.license.url !== `${rawRoot}COPYING`) {
    context.addIssue({ code: "custom", message: "Git license authority is inconsistent" });
  }
  for (const source of git.sources) {
    if (source.path !== `${root}${source.upstreamPath}` || source.url !== `${rawRoot}${source.upstreamPath}`) {
      context.addIssue({ code: "custom", message: `Git source authority is inconsistent: ${source.id}` });
    }
    const expected = source.upstreamPath === "path.c"
      ? {
          id: `git-${git.upstream.version}-path-c`,
          role: "production-ntfs-alias-algorithm-authority",
        }
      : source.upstreamPath === "t/t0060-path-utils.sh"
        ? {
            id: `git-${git.upstream.version}-t0060-path-utils`,
            role: "upstream-ntfs-alias-boundary-test-authority",
          }
        : undefined;
    if (expected === undefined || source.id !== expected.id || source.role !== expected.role) {
      context.addIssue({ code: "custom", message: `Git source role is inconsistent: ${source.upstreamPath}` });
    }
  }
  const upstreamPaths = git.sources.map((source) => source.upstreamPath).toSorted();
  if (upstreamPaths[0] !== "path.c" || upstreamPaths[1] !== "t/t0060-path-utils.sh") {
    context.addIssue({ code: "custom", message: "Required Git path sources are absent" });
  }
});

export type UnicodePathSourceManifest = Readonly<z.infer<typeof SOURCE_MANIFEST_SCHEMA>>;
export type PathPolicySourceManifest = Readonly<z.infer<typeof PATH_POLICY_SOURCE_MANIFEST_SCHEMA>>;
export type CaseFoldingEntry = readonly [number, readonly number[]];
export type DerivedCaseFoldingAuthority = Readonly<{
  entries: readonly CaseFoldingEntry[];
  tableJson: string;
  tableByteLength: number;
  tableSha256: string;
  maximumExpansionCodePoints: number;
  moduleSource: string;
}>;

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const PATH_POLICY_MANIFEST_RELATIVE_PATH = "traceability/sources/path-policy/manifest.json" as const;
const UNICODE_MANIFEST_RELATIVE_PATH =
  "traceability/sources/path-policy/unicode-17.0.0/manifest.json" as const;
const GENERATED_RELATIVE_PATH = "src/repository-path/unicode-case-fold.generated.ts" as const;

export function parseUnicodePathSourceManifest(text: string): UnicodePathSourceManifest {
  assertNoDuplicateJsonObjectKeys(
    text,
    "Unicode path source manifest contains a duplicate key",
    "repository_path_unicode_manifest_duplicate_key",
  );
  return deepFreeze(SOURCE_MANIFEST_SCHEMA.parse(JSON.parse(text) as unknown));
}

export function parsePathPolicySourceManifest(text: string): PathPolicySourceManifest {
  assertNoDuplicateJsonObjectKeys(
    text,
    "Path policy source manifest contains a duplicate key",
    "repository_path_source_manifest_duplicate_key",
  );
  return deepFreeze(PATH_POLICY_SOURCE_MANIFEST_SCHEMA.parse(JSON.parse(text) as unknown));
}

export function deriveCaseFoldingAuthority(
  sourceText: string,
  manifest: UnicodePathSourceManifest,
): DerivedCaseFoldingAuthority {
  const caseFoldingSource = requiredSource(manifest, "unicode-17.0.0-case-folding");
  if (Buffer.byteLength(sourceText, "utf8") !== caseFoldingSource.byteLength ||
    sha256(sourceText) !== caseFoldingSource.sha256) {
    throw new InputError(
      "Case-folding source does not match the canonical manifest",
      "repository_path_unicode_source_identity_invalid",
    );
  }
  if (!sourceText.startsWith(`# CaseFolding-${manifest.unicodeVersion}.txt\n`) ||
    !/^# Date: [0-9-]+, [0-9:]+ GMT$/mu.test(sourceText)) {
    throw new InputError("Case-folding source identity is invalid", "repository_path_case_folding_header_invalid");
  }
  const selected = new Map<number, readonly number[]>();
  for (const [lineIndex, line] of sourceText.split("\n").entries()) {
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = /^([0-9A-F]{4,6}); ([CFST]); ((?:[0-9A-F]{4,6} ?)+); # .+$/u.exec(line);
    if (!match) {
      throw new InputError(
        `Case-folding source line ${lineIndex + 1} is malformed`,
        "repository_path_case_folding_source_invalid",
      );
    }
    if (match[2] !== "C" && match[2] !== "F") continue;
    const source = Number.parseInt(match[1]!, 16);
    const mapping = match[3]!.trim().split(" ").map((value) => Number.parseInt(value, 16));
    if (!isUnicodeScalar(source) || mapping.some((value) => !isUnicodeScalar(value)) ||
      mapping.length < 1 || mapping.length > manifest.productionAuthority.maximumCaseFoldingExpansionCodePoints ||
      selected.has(source)) {
      throw new InputError(
        `Case-folding source line ${lineIndex + 1} is invalid`,
        "repository_path_case_folding_source_invalid",
      );
    }
    selected.set(source, mapping);
  }
  const entries = [...selected.entries()].toSorted((left, right) => left[0] - right[0]);
  const maximumExpansionCodePoints = Math.max(...entries.map((entry) => entry[1].length));
  if (entries.length !== manifest.productionAuthority.expectedCaseFoldingEntries ||
    maximumExpansionCodePoints !== manifest.productionAuthority.maximumCaseFoldingExpansionCodePoints) {
    throw new InputError(
      "Case-folding selection does not match the source manifest",
      "repository_path_case_folding_selection_invalid",
    );
  }
  const tableJson = JSON.stringify(entries);
  const tableByteLength = Buffer.byteLength(tableJson, "utf8");
  const tableSha256 = sha256(tableJson);
  return deepFreeze({
    entries,
    tableJson,
    tableByteLength,
    tableSha256,
    maximumExpansionCodePoints,
    moduleSource: renderGeneratedCaseFoldingModule({
      unicodeVersion: manifest.unicodeVersion,
      sourceSha256: caseFoldingSource.sha256,
      tableJson,
      tableByteLength,
      tableSha256,
      entryCount: entries.length,
    }),
  });
}

export function assertGeneratedCaseFoldingModule(current: string, expected: string): void {
  if (current !== expected) {
    throw new InputError(
      "Generated repository path case-folding module is stale",
      "repository_path_generated_table_stale",
    );
  }
}

export function renderGeneratedCaseFoldingModule(input: Readonly<{
  unicodeVersion: string;
  sourceSha256: string;
  tableJson: string;
  tableByteLength: number;
  tableSha256: string;
  entryCount: number;
}>): string {
  return `/* Generated by scripts/generation/repository-path-unicode.ts. Do not edit. */
import { deepFreeze } from "../kernel/integrity.ts";

export const UNICODE_CASE_FOLDING_GENERATOR_REVISION =
  "${REPOSITORY_PATH_UNICODE_GENERATOR_REVISION}" as const;
export const UNICODE_CASE_FOLDING_VERSION = "${input.unicodeVersion}" as const;
export const UNICODE_CASE_FOLDING_SOURCE_SHA256 =
  "${input.sourceSha256}" as const;
export const UNICODE_CASE_FOLDING_TABLE_SHA256 =
  "${input.tableSha256}" as const;
export const UNICODE_CASE_FOLDING_TABLE_BYTE_LENGTH = ${numericLiteral(input.tableByteLength)} as const;
export const UNICODE_CASE_FOLDING_ENTRY_COUNT = ${numericLiteral(input.entryCount)} as const;

export type UnicodeCaseFoldingEntry = readonly [number, readonly number[]];

export const UNICODE_CASE_FOLDING_TABLE_JSON = ${JSON.stringify(input.tableJson)} as const;
export const UNICODE_CASE_FOLDING_TABLE: readonly UnicodeCaseFoldingEntry[] = deepFreeze(
  JSON.parse(UNICODE_CASE_FOLDING_TABLE_JSON) as UnicodeCaseFoldingEntry[],
);
`;
}

export function deriveRepositoryPathUnicodeFoundation(repositoryRoot: string): Readonly<{
  report: Readonly<Record<string, unknown>>;
  generatedSource: string;
}> {
  const pathPolicyManifestText = readFatalUtf8(join(repositoryRoot, PATH_POLICY_MANIFEST_RELATIVE_PATH));
  const pathPolicyManifest = parsePathPolicySourceManifest(pathPolicyManifestText);
  verifyPathPolicySourceIdentities(repositoryRoot, pathPolicyManifest);
  const manifestText = readFatalUtf8(join(repositoryRoot, UNICODE_MANIFEST_RELATIVE_PATH));
  const manifest = parseUnicodePathSourceManifest(manifestText);
  verifySourceIdentities(repositoryRoot, manifest);
  const caseFoldingSource = requiredSource(manifest, "unicode-17.0.0-case-folding");
  const sourceText = readFatalUtf8(join(repositoryRoot, caseFoldingSource.path));
  const authority = deriveCaseFoldingAuthority(sourceText, manifest);
  const normalization = requiredSource(manifest, "unicode-17.0.0-normalization-test");
  const report = deepFreeze({
    schemaVersion: REPOSITORY_PATH_UNICODE_DERIVATION_SCHEMA_VERSION,
    disposition: "foundation-derived-not-admitted-or-qualified",
    generatorRevision: REPOSITORY_PATH_UNICODE_GENERATOR_REVISION,
    sourceAuthority: {
      checkRevision: REPOSITORY_PATH_SOURCE_AUTHORITY_CHECK_REVISION,
      pathPolicyManifest: {
        path: PATH_POLICY_MANIFEST_RELATIVE_PATH,
        sha256: sha256(pathPolicyManifestText),
      },
      unicodeManifest: {
        path: UNICODE_MANIFEST_RELATIVE_PATH,
        sha256: sha256(manifestText),
      },
      git: {
        tag: pathPolicyManifest.sourceSets.git.upstream.tag,
        commit: pathPolicyManifest.sourceSets.git.upstream.commit,
        licenseSha256: pathPolicyManifest.sourceSets.git.license.sha256,
        sources: pathPolicyManifest.sourceSets.git.sources.map((source) => ({
          id: source.id,
          sha256: source.sha256,
        })),
      },
    },
    unicodeVersion: manifest.unicodeVersion,
    caseFolding: {
      sourceSha256: caseFoldingSource.sha256,
      entries: authority.entries.length,
      maximumExpansionCodePoints: authority.maximumExpansionCodePoints,
      tableByteLength: authority.tableByteLength,
      tableSha256: authority.tableSha256,
    },
    normalization: {
      sourceSha256: normalization.sha256,
      sourceByteLength: normalization.byteLength,
    },
    generatedModule: {
      path: GENERATED_RELATIVE_PATH,
      byteLength: Buffer.byteLength(authority.moduleSource, "utf8"),
      sha256: sha256(authority.moduleSource),
    },
  });
  return deepFreeze({ report, generatedSource: authority.moduleSource });
}

function verifyPathPolicySourceIdentities(
  repositoryRoot: string,
  manifest: PathPolicySourceManifest,
): void {
  const bindings = [
    manifest.sourceSets.unicode.manifest,
    manifest.sourceSets.git.license,
    ...manifest.sourceSets.git.sources,
  ];
  for (const binding of bindings) {
    const bytes = readFileSync(join(repositoryRoot, binding.path));
    if (bytes.byteLength !== binding.byteLength || sha256(bytes) !== binding.sha256) {
      throw new InputError(
        "Vendored path policy source identity is invalid",
        "repository_path_source_identity_invalid",
      );
    }
    decodeFatalUtf8(bytes);
  }
}

export function runRepositoryPathUnicodeGenerator(argv: readonly string[]): void {
  const mode = argv.length === 0 ? "--check" : argv[0];
  if (argv.length > 1 || !["--check", "--derive", "--write"].includes(mode!)) {
    throw new InputError(
      "Usage: repository-path-unicode [--check|--derive|--write]",
      "repository_path_unicode_generator_usage_invalid",
    );
  }
  if (mode === "--write") {
    throw new InputError(
      "Repository path generation writes require the unavailable production migration authority",
      "repository_path_generation_write_authority_unavailable",
    );
  }
  const repositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const derived = deriveRepositoryPathUnicodeFoundation(repositoryRoot);
  if (mode === "--check") {
    const current = readFatalUtf8(join(repositoryRoot, GENERATED_RELATIVE_PATH));
    assertGeneratedCaseFoldingModule(current, derived.generatedSource);
  }
  process.stdout.write(`${canonicalJson(derived.report)}\n`);
}

function verifySourceIdentities(repositoryRoot: string, manifest: UnicodePathSourceManifest): void {
  const sources = [manifest.license, ...manifest.sources];
  for (const source of sources) {
    const bytes = readFileSync(join(repositoryRoot, source.path));
    if (bytes.byteLength !== source.byteLength || sha256(bytes) !== source.sha256) {
      throw new InputError(
        "Vendored Unicode source identity is invalid",
        "repository_path_unicode_source_identity_invalid",
      );
    }
    decodeFatalUtf8(bytes);
  }
}

function requiredSource(manifest: UnicodePathSourceManifest, id: string) {
  const source = manifest.sources.find((entry) => entry.id === id);
  if (!source) {
    throw new InputError("Required Unicode source is absent", "repository_path_unicode_source_absent");
  }
  return source;
}

function readFatalUtf8(path: string): string {
  return decodeFatalUtf8(readFileSync(path));
}

function decodeFatalUtf8(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new InputError("Unicode sources must not contain a byte-order mark", "repository_path_unicode_bom_forbidden");
  }
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    throw new InputError("Unicode source is not fatal UTF-8", "repository_path_unicode_utf8_invalid");
  }
}

function numericLiteral(value: number): string {
  return value.toString(10).replace(/\B(?=(\d{3})+(?!\d))/gu, "_");
}

function isUnicodeScalar(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0x10ffff &&
    (value < 0xd800 || value > 0xdfff);
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  runRepositoryPathUnicodeGenerator(process.argv.slice(2));
}
