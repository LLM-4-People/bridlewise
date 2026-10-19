import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseTypeScriptAst } from "@babel/parser";
import { astChildren } from "../src/quality-packs/prevention/ast-helpers.ts";
import { z } from "zod";

import {
  canonicalHash,
  canonicalDomainHash,
  canonicalJson,
  deepFreeze,
  sha256,
  type DeepReadonly,
} from "../src/kernel/integrity.ts";
import { commitJournaled, journalPathFor, recoverJournaledCommit, type JournalRecovery } from "../src/filesystem/journaled-commit.ts";
import { presentTrackedFiles } from "../src/git/repository-ownership.ts";
import { assertNoDuplicateJsonObjectKeys } from "../src/kernel/json-integrity.ts";
import { relativePathViolationKinds } from "../src/filesystem/path-boundary.ts";
import { compareUtf8Bytes } from "../src/kernel/ordered.ts";
import { ROOT_POLICY } from "../src/kernel/root-policy.ts";
import { VERIFICATION_PATHS } from "../src/kernel/verification-paths.ts";
import { extractErrorMessage, HarnessError } from "../src/kernel/errors.ts";
import {
  listSafeRepositoryTree,
  readSafeRepositoryFile,
  type SafeRepositoryTreeEntry,
} from "./verification/safe-repository-reader.ts";
import { shouldExcludeExperiment } from "../src/shared/source-scan.ts";
import { bootstrapProcess, isEntryPoint } from "../src/runtime/cli-debug.ts";
import {
  assertTestSurfaceConservation,
  buildTestSurfaceScope,
  isQualifiedCanonicalNodeTestSource,
  isScannedRecognizableTestSource,
  parseTestSurfaceDispositionManifestText,
  parseTestSurfaceScope,
  recognizableTestSourceLanguage,
  TEST_SURFACE_SCOPE_SCHEMA,
  type TestSurfaceDispositionManifest,
  type TestSurfaceScope,
} from "./verification/test-surface.ts";

const INVENTORY_PATH = VERIFICATION_PATHS.testInventory;
const ROOT_POLICY_PATH = "src/kernel/root-policy.ts";
/** The name of the inventory transaction's journal (the owner derives its path: `journalPathFor`). */
const TRANSACTION_JOURNAL = "test-inventory";
const GENERATOR_REVISION = "test-inventory-generator/v4";
const TEST_DISCOVERY = ROOT_POLICY.verification.testDiscovery;
const TEST_INVENTORY_ENTRY_HASH_DOMAIN = "test-inventory.entry/v1";
const TEST_INVENTORY_DOCUMENT_HASH_DOMAIN = "test-inventory.document/v4";
const TEST_SURFACE_FINGERPRINT_HASH_DOMAIN = "test-surface-fingerprint/v1";

const ENTRY_SCHEMA = z.strictObject({
  id: z.string().regex(/^[0-9a-f]{64}$/u),
  sourceId: z.string().refine(testSourceIdIsAllowed),
  sourceHash: z.string().regex(/^[0-9a-f]{64}$/u),
  name: z.string().min(1),
});

const INVENTORY_SCHEMA = z.strictObject({
  schemaVersion: z.literal(ROOT_POLICY.verification.testInventorySchema),
  scope: TEST_SURFACE_SCOPE_SCHEMA,
  tests: z.array(ENTRY_SCHEMA).min(1),
  inventoryHash: z.string().regex(/^[0-9a-f]{64}$/u),
});

const LEGACY_V1_V2_INVENTORY_SCHEMA = z.strictObject({
  schemaVersion: z.enum(["bridlewise-test-inventory/v1", "bridlewise-test-inventory/v2"]),
  tests: z.array(ENTRY_SCHEMA).min(1),
  inventoryHash: z.string().regex(/^[0-9a-f]{64}$/u),
});

const LEGACY_V3_INVENTORY_SCHEMA = z.strictObject({
  schemaVersion: z.literal("bridlewise-test-inventory/v3"),
  scope: TEST_SURFACE_SCOPE_SCHEMA,
  tests: z.array(ENTRY_SCHEMA).min(1),
  inventoryHash: z.string().regex(/^[0-9a-f]{64}$/u),
});

export type TestInventoryEntry = Readonly<z.infer<typeof ENTRY_SCHEMA>>;
export type TestInventory = DeepReadonly<z.infer<typeof INVENTORY_SCHEMA>>;
export type TestInventoryBuildOptions = Readonly<{
  dispositionManifest?: TestSurfaceDispositionManifest;
}>;

type AstNode = Readonly<Record<string, unknown> & { type: string }>;
type StaticLoopValue = boolean | null | number | string | StaticLoopArray | StaticLoopRecord | StaticLoopOpaque;
interface StaticLoopArray extends ReadonlyArray<StaticLoopValue> {}
interface StaticLoopRecord { readonly [key: string]: StaticLoopValue }
interface StaticLoopOpaque { readonly staticLoopOpaque: true }
type StaticEvaluationBudget = { remaining: number };
type TestRegistrationAuthority = Readonly<{
  registrars: ReadonlySet<string>;
  wrapperImplementationCalls: ReadonlySet<AstNode>;
  describeNames: ReadonlySet<string>;
}>;
type TestSourceRead = Readonly<{
  sourceId: string;
  bytes: Buffer;
  sourceHash: string;
}>;
type TestSourceSnapshot = Readonly<{
  scope: TestSurfaceScope;
  recognizablePaths: readonly string[];
  sources: readonly TestSourceRead[];
}>;

/**
 * Hash-only projection of a test-source snapshot. Carries everything needed
 * to re-verify that the current on-disk sources still match the snapshot
 * WITHOUT re-parsing every source with Babel: the scope (which validates the
 * recognizable path set) and the per-source SHA-256 digests computed during
 * the one full build. A byte-identical source produces byte-identical
 * discovered test names, so a digest match is a sound substitute for a
 * re-parse in the post-run assertion.
 */
export type TestInventorySourceSnapshot = Readonly<{
  scope: TestSurfaceScope;
  recognizablePaths: readonly string[];
  sourceHashes: ReadonlyMap<string, string>;
}>;

const STATIC_LOOP_OPAQUE: StaticLoopOpaque = Object.freeze({ staticLoopOpaque: true });

export function discoverTestNames(source: string): readonly string[] {
  if (typeof source !== "string") throw new Error("test source must be a string");
  if (Buffer.byteLength(source, "utf8") > TEST_DISCOVERY.maximumSourceBytes) {
    throw new Error("test source exceeds the configured discovery byte ceiling");
  }
  const parsed = parseTypeScriptAst(source, {
    sourceType: "module",
    plugins: ["typescript"],
    errorRecovery: false,
  }) as unknown as { program?: { body?: unknown[] } };
  if (!Array.isArray(parsed.program?.body)) throw new Error("test source has no program body");
  const body = parsed.program.body.filter(isAstNode);
  assertTestDiscoveryAstBudget(body);
  const bindings = topLevelBindings(body);
  const authority = testRegistrationAuthority(body);
  const allTestCalls = collectTestCalls(
    body,
    authority.registrars,
    authority.wrapperImplementationCalls,
  );
  const modeledCalls = new Set<AstNode>();
  const names: string[] = [];

  for (const statement of body) {
    const directCall = expressionTestCall(statement, authority.registrars);
    if (directCall) {
      assertModeledRegistrationCapacity(names.length, 1);
      names.push(evaluateTestName(callFirstArgument(directCall), new Map()));
      modeledCalls.add(directCall);
      continue;
    }
    const describeCall = expressionDescribeCall(statement, authority.describeNames);
    if (describeCall) {
      modelDescribeCallback(describeCall, authority, names, modeledCalls, bindings);
      continue;
    }
    if (statement.type === "ForOfStatement") {
      modelForOfRegistrations(statement, authority, bindings, names, modeledCalls, "");
      continue;
    }
    if (statement.type === "ForStatement") {
      const { binding, values } = positiveStaticIntegerLoop(statement);
      const loopCalls = directLoopTestCalls(statement.body, authority.registrars, new Set([binding]));
      for (const call of loopCalls) modeledCalls.add(call);
      assertModeledRegistrationCapacity(names.length, values.length * loopCalls.length);
      for (const value of values) {
        const environment = new Map<string, StaticLoopValue>([[binding, value]]);
        for (const call of loopCalls) names.push(evaluateTestName(callFirstArgument(call), environment));
      }
    }
  }

  if (allTestCalls.length !== modeledCalls.size || allTestCalls.some((call) => !modeledCalls.has(call))) {
    throw new Error("test registration shape is not statically modeled");
  }
  if (names.length === 0) throw new Error("test source contains no modeled test registrations");
  if (new Set(names).size !== names.length) throw new Error("test source contains duplicate test names");
  return Object.freeze(names);
}

function assertModeledRegistrationCapacity(current: number, additional: number): void {
  if (!Number.isSafeInteger(additional) || additional < 0 ||
    additional > TEST_DISCOVERY.maximumEntries - current) {
    throw new Error("modeled test registration count exceeds the configured inventory entry ceiling");
  }
}

function assertTestDiscoveryAstBudget(values: readonly unknown[]): void {
  const pending: Array<Readonly<{ value: unknown; depth: number }>> =
    values.map((value) => ({ value, depth: 0 }));
  const visited = new Set<object>();
  let nodes = 0;
  while (pending.length > 0) {
    const { value, depth } = pending.pop()!;
    if (Array.isArray(value)) {
      for (const entry of value) pending.push({ value: entry, depth });
      continue;
    }
    if (!isAstNode(value) || visited.has(value)) continue;
    visited.add(value);
    nodes += 1;
    if (nodes > TEST_DISCOVERY.maximumAstNodes) {
      throw new Error("test source exceeds the configured AST node ceiling");
    }
    if (depth > TEST_DISCOVERY.maximumAstDepth) {
      throw new Error("test source exceeds the configured AST depth ceiling");
    }
    for (const child of astChildren(value)) pending.push({ value: child, depth: depth + 1 });
  }
}

export function buildTestInventory(
  candidateRoot: string,
  options: TestInventoryBuildOptions = {},
): TestInventory {
  if (typeof candidateRoot !== "string") throw new Error("candidate root must be a string");
  const root = resolve(candidateRoot);
  const snapshot = readTestSourceSnapshot(root, options.dispositionManifest);
  return buildTestInventoryFromSnapshot(snapshot);
}

function buildTestInventoryFromSnapshot(snapshot: TestSourceSnapshot): TestInventory {
  if (snapshot.sources.length === 0) throw new Error("test inventory source surface is empty");
  const tests: TestInventoryEntry[] = [];
  for (const { sourceId, bytes, sourceHash } of snapshot.sources) {
    for (const name of discoverTestNames(decodeTestSource(bytes, sourceId))) {
      tests.push(createTestInventoryEntry(sourceId, sourceHash, name));
    }
  }
  return createTestInventory(snapshot.scope, tests);
}

export function createTestInventoryEntry(
  sourceId: string,
  sourceHash: string,
  name: string,
): TestInventoryEntry {
  return ENTRY_SCHEMA.parse({
    id: testInventoryEntryIdentity(sourceId, sourceHash, name),
    sourceId,
    sourceHash,
    name,
  });
}

export function testInventoryEntryIdentity(
  sourceId: string,
  sourceHash: string,
  name: string,
): string {
  return canonicalDomainHash(TEST_INVENTORY_ENTRY_HASH_DOMAIN, { sourceId, sourceHash, name });
}

export function testInventoryIdentity(
  scope: TestSurfaceScope,
  tests: readonly TestInventoryEntry[],
): string {
  return canonicalDomainHash(TEST_INVENTORY_DOCUMENT_HASH_DOMAIN, { scope, tests });
}

export function createTestInventory(
  scope: TestSurfaceScope,
  tests: readonly TestInventoryEntry[],
): TestInventory {
  return parseTestInventoryDocument({
    schemaVersion: ROOT_POLICY.verification.testInventorySchema,
    scope,
    tests: [...tests],
    inventoryHash: testInventoryIdentity(scope, tests),
  });
}

/**
 * Replaces the inventory and the root policy's pin of it as ONE journaled
 * transaction (`src/filesystem/journaled-commit.ts`, the one multi-file
 * commit owner, which also asks the checkout write door for both files).
 * Phases: `journal-written`, `staged`, `committed:<path>`, `verified`.
 */
export function writeTestInventoryTransaction(
  candidateRoot: string,
  inventory: TestInventory,
  onPhase: (phase: string) => void = () => undefined,
  options: TestInventoryBuildOptions = {},
): void {
  const root = resolve(candidateRoot);
  const inventoryPath = join(root, INVENTORY_PATH);
  const rootPolicyPath = join(root, ROOT_POLICY_PATH);
  const nextInventory = parseTestInventoryDocument(inventory);
  assertInventoryMatchesBoundProjection(root, nextInventory, options);
  const baseInventory = parseInventoryBase(readFileSync(inventoryPath, "utf8"));
  const nextRootPolicyText = replacePinnedInventoryHash(
    readFileSync(rootPolicyPath, "utf8"),
    baseInventory.inventoryHash,
    nextInventory.inventoryHash,
  );
  commitJournaled(root, TRANSACTION_JOURNAL, [
    { path: ROOT_POLICY_PATH, bytes: Buffer.from(nextRootPolicyText, "utf8"), mode: statSync(rootPolicyPath).mode & 0o7777 },
    { path: INVENTORY_PATH, bytes: Buffer.from(`${canonicalJson(nextInventory)}\n`, "utf8"), mode: statSync(inventoryPath).mode & 0o7777 },
  ], { onPhase });
}

export function recoverTestInventoryTransaction(candidateRoot: string): JournalRecovery {
  return recoverJournaledCommit(resolve(candidateRoot), TRANSACTION_JOURNAL);
}

export function loadTestInventory(candidateRoot: string): TestInventory {
  return loadTestInventoryWithSnapshot(candidateRoot).inventory;
}

/**
 * Load and fully validate the pinned inventory exactly once, returning the
 * hash-only source snapshot captured during that single build. Callers that
 * re-assert the snapshot later (before/after test execution) pass the
 * snapshot to {@link assertTestInventorySourceSnapshot} so the re-assertion
 * re-reads and re-hashes sources but skips the redundant Babel re-parse.
 */
export function loadTestInventoryWithSnapshot(candidateRoot: string): Readonly<{
  inventory: TestInventory;
  snapshot: TestInventorySourceSnapshot;
}> {
  if (typeof candidateRoot !== "string") throw new Error("candidate root must be a string");
  const root = resolve(candidateRoot);
  const inventoryText = decodeTestSource(
    readSafeRepositoryFile(root, INVENTORY_PATH, TEST_DISCOVERY.maximumInventoryBytes).bytes,
    INVENTORY_PATH,
  );
  assertNoDuplicateJsonObjectKeys(
    inventoryText,
    "Test inventory contains a duplicate key",
    "test_inventory_key_duplicate",
  );
  const value: unknown = JSON.parse(inventoryText);
  const inventory = parseTestInventoryDocument(value);
  if (inventory.schemaVersion !== ROOT_POLICY.verification.testInventorySchema ||
    inventory.inventoryHash !== ROOT_POLICY.verification.testInventoryHash) {
    throw new Error("test inventory hash is invalid");
  }
  const built = readTestSourceSnapshot(root);
  assertSameTestInventoryProjection(inventory, buildTestInventoryFromSnapshot(built));
  return deepFreeze({ inventory, snapshot: testInventorySnapshotHashes(built) });
}

function testInventorySnapshotHashes(snapshot: TestSourceSnapshot): TestInventorySourceSnapshot {
  return deepFreeze({
    scope: snapshot.scope,
    recognizablePaths: snapshot.recognizablePaths,
    sourceHashes: new Map(snapshot.sources.map((source) => [source.sourceId, source.sourceHash])),
  });
}

export function assertTestInventorySourceSnapshot(
  candidateRoot: string,
  inventory: TestInventory,
  snapshot?: TestInventorySourceSnapshot,
): void {
  if (typeof candidateRoot !== "string") throw new Error("candidate root must be a string");
  const root = resolve(candidateRoot);
  const parsed = parseTestInventoryDocument(inventory);
  if (snapshot === undefined) {
    assertInventoryMatchesCurrentSources(root, parsed);
    return;
  }
  assertInventoryMatchesSnapshotHashes(root, parsed, snapshot);
}

/**
 * Cheap re-assertion against a snapshot captured by a prior full validation:
 * re-walks the recognizable surface and re-reads/re-hashes the canonical
 * sources (proving no byte changed since the snapshot), but skips the Babel
 * re-parse because byte-identical sources yield identical discovered names.
 */
function assertInventoryMatchesSnapshotHashes(
  root: string,
  inventory: TestInventory,
  snapshot: TestInventorySourceSnapshot,
): void {
  if (canonicalHash(inventory.scope) !== canonicalHash(snapshot.scope)) {
    throw new Error("test inventory snapshot scope is invalid");
  }
  for (const entry of inventory.tests) {
    if (snapshot.sourceHashes.get(entry.sourceId) !== entry.sourceHash) {
      throw new Error("test inventory snapshot source hash is invalid");
    }
  }
  const current = readTestSourceSnapshotForScope(root, snapshot.scope);
  const currentHashes = new Map(current.sources.map((source) => [source.sourceId, source.sourceHash]));
  if (currentHashes.size !== snapshot.sourceHashes.size) {
    throw new Error("test inventory source scope is stale");
  }
  for (const [sourceId, sourceHash] of snapshot.sourceHashes) {
    if (currentHashes.get(sourceId) !== sourceHash) {
      throw new Error("test inventory source hash is invalid");
    }
  }
}

export function testFilesFromInventory(candidateRoot: string, inventory: TestInventory): readonly string[] {
  if (typeof candidateRoot !== "string") throw new Error("candidate root must be a string");
  const root = resolve(candidateRoot);
  const validated = parseTestInventoryDocument(inventory);
  const sourceIds = [...new Set(validated.tests.map((entry) => entry.sourceId))].toSorted(compareUtf8Bytes);
  if (sourceIds.length === 0 || sourceIds.some((sourceId) => !testSourceIdIsAllowed(sourceId))) {
    throw new Error("test inventory file list is invalid");
  }
  return Object.freeze(sourceIds.map((sourceId) => join(root, sourceId)));
}

function testSourceIdIsAllowed(sourceId: string): boolean {
  return relativePathViolationKinds(sourceId).length === 0 && isQualifiedCanonicalNodeTestSource(sourceId);
}

export function parseTestInventoryDocument(value: unknown): TestInventory {
  const parsed = INVENTORY_SCHEMA.safeParse(value);
  if (!parsed.success) throw new Error("test inventory schema is invalid");
  const inventory = parsed.data;
  const scope = parseTestSurfaceScope(inventory.scope);
  if (scope.unsupportedSourceIds.length > 0) {
    throw new Error("test inventory contains an unsupported test surface");
  }
  const inventorySourceIds = [...new Set(inventory.tests.map((entry) => entry.sourceId))].toSorted(compareUtf8Bytes);
  if (canonicalHash(inventorySourceIds) !== canonicalHash(scope.canonicalNodeSourceIds)) {
    throw new Error("test inventory source scope is invalid");
  }
  if (testInventoryIdentity(scope, inventory.tests) !== inventory.inventoryHash) {
    throw new Error("test inventory hash is invalid");
  }
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const entry of inventory.tests) {
    const key = `${entry.sourceId}\0${entry.name}`;
    if (ids.has(entry.id) || keys.has(key)) throw new Error("test inventory contains duplicates");
    ids.add(entry.id);
    keys.add(key);
    if (entry.id !== testInventoryEntryIdentity(entry.sourceId, entry.sourceHash, entry.name)) {
      throw new Error("test inventory entry identity is invalid");
    }
  }
  return deepFreeze(inventory);
}

function assertInventoryMatchesBoundProjection(
  root: string,
  inventory: TestInventory,
  options: TestInventoryBuildOptions = {},
): void {
  const expected = buildTestInventory(root, options);
  assertSameTestInventoryProjection(inventory, expected);
}

function assertInventoryMatchesCurrentSources(root: string, inventory: TestInventory): void {
  const expected = buildTestInventoryFromSnapshot(readTestSourceSnapshotForScope(root, inventory.scope));
  assertSameTestInventoryProjection(inventory, expected);
}

function assertSameTestInventoryProjection(inventory: TestInventory, expected: TestInventory): void {
  const sourcesById = new Map(expected.tests.map((entry) => [entry.sourceId, entry.sourceHash]));
  for (const entry of inventory.tests) {
    if (sourcesById.get(entry.sourceId) !== entry.sourceHash) {
      throw new Error("test inventory source hash is invalid");
    }
  }
  if (inventory.inventoryHash !== expected.inventoryHash ||
    canonicalHash(inventory.scope) !== canonicalHash(expected.scope) ||
    canonicalHash(inventory.tests) !== canonicalHash(expected.tests)) {
    throw new Error("test inventory does not exactly match the current test-source projection");
  }
}

/**
 * The current test-surface scope, read the way the generator reads it. Kept
 * separate from `buildTestInventory` so the conservation refusal runs BEFORE
 * any inventory work and its failure names the surface rather than the build.
 */
function scopeForConservation(root: string): TestSurfaceScope {
  const { recognizablePaths } = readRecognizableTestSurface(root);
  return buildTestSurfaceScope(recognizablePaths, loadBoundTestSurfaceManifest(root));
}

function main(argv: readonly string[]): number {
  if (argv.length !== 1 || !["--write", "--check", "--recover"].includes(argv[0]!)) {
    throw new Error("Usage: test-inventory --write|--check|--recover");
  }
  const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
  if (argv[0] === "--recover") {
    const status = recoverTestInventoryTransaction(root);
    process.stdout.write(`${canonicalJson({ generatorRevision: GENERATOR_REVISION, status })}\n`);
    return 0;
  }
  // ── THE REFUSALS RUN HERE, AND ONLY HERE ────────────────────────────────
  //
  // This is the CLI door: `harness regenerate` and the `npm test` auto-heal
  // both arrive through it, and `root` is always the real repository. The
  // snapshot readers below are deliberately NOT the site — they are driven
  // over synthetic temporary roots by the inventory tests, which have no git
  // index, and a refusal that has to be skipped for a fixture is a refusal
  // that will be skipped in production the first time it is inconvenient.
  //
  // The receipt is not decoration: it is emitted in the status payload below,
  // so a swallowed call cannot produce the numbers the caller reads back.
  const gitRecognizable = gitTrackedRecognizableTestPaths(root);
  const conservation = gitRecognizable === undefined
    ? ({ kind: "unavailable", reason: "root is not a git working tree" } as const)
    : { kind: "verified", ...assertTestSurfaceConservation(gitRecognizable, scopeForConservation(root)) } as const;
  const transactionPresent = existsSync(journalPathFor(root, TRANSACTION_JOURNAL));
  const inventory = buildTestInventory(root);
  const inventoryBytes = `${canonicalJson(inventory)}\n`;
  const inventoryPath = join(root, INVENTORY_PATH);
  const rootPolicyPath = join(root, ROOT_POLICY_PATH);
  const rootPolicyBytes = readFileSync(rootPolicyPath, "utf8");
  const baseInventory = parseInventoryBase(readFileSync(inventoryPath, "utf8"));
  const updatedRootPolicyBytes = replacePinnedInventoryHash(
    rootPolicyBytes,
    baseInventory.inventoryHash,
    inventory.inventoryHash,
  );
  const inventoryMatches = readFileSync(inventoryPath, "utf8") === inventoryBytes;
  const rootPolicyMatches = rootPolicyBytes === updatedRootPolicyBytes;
  const sourceSetHash = canonicalHash([...new Map(inventory.tests.map((entry) => [
    entry.sourceId,
    { sourceId: entry.sourceId, sourceHash: entry.sourceHash },
  ])).values()]);

  if (argv[0] === "--check") {
    process.stdout.write(`${canonicalJson({
      generatorRevision: GENERATOR_REVISION,
      inventoryHash: inventory.inventoryHash,
      sourceSetHash,
      status: inventoryMatches && rootPolicyMatches && !transactionPresent ? "current" : "drift",
      testCount: inventory.tests.length,
      transactionPresent,
      conservation,
    })}\n`);
    return inventoryMatches && rootPolicyMatches && !transactionPresent ? 0 : 1;
  }

  if (transactionPresent) throw new Error("test inventory transaction recovery is required");
  if (!inventoryMatches || !rootPolicyMatches) writeTestInventoryTransaction(root, inventory);
  process.stdout.write(`${canonicalJson({
    generatorRevision: GENERATOR_REVISION,
    inventoryHash: inventory.inventoryHash,
    sourceSetHash,
    status: inventoryMatches && rootPolicyMatches ? "current" : "written",
    testCount: inventory.tests.length,
    conservation,
  })}\n`);
  return 0;
}

function readTestSourceSnapshot(
  root: string,
  dispositionManifest?: TestSurfaceDispositionManifest,
): TestSourceSnapshot {
  const { before, recognizablePaths } = readRecognizableTestSurface(root);
  const manifest = dispositionManifest ?? loadBoundTestSurfaceManifest(root);
  const scope = buildTestSurfaceScope(recognizablePaths, manifest);
  if (scope.unsupportedSourceIds.length > 0) {
    throw new Error(`${TEST_DISCOVERY.dispositionRegistry.qualificationGuidance}: ${scope.unsupportedSourceIds.join(",")}`);
  }
  return readCanonicalTestSources(root, before, recognizablePaths, scope);
}

/**
 * Cheap drift fingerprint for the auto-heal gate: covers the recognizable
 * test-surface file set (path + size + mtime) plus the byte hashes of the
 * disposition manifest, the pinned inventory, and the root policy. A change
 * to any of these invalidates the fingerprint and forces a regeneration;
 * an unchanged fingerprint proves the recorded regeneration is still current.
 */
export function computeTestSurfaceFingerprint(candidateRoot: string): string {
  if (typeof candidateRoot !== "string") throw new Error("candidate root must be a string");
  const root = resolve(candidateRoot);
  const { recognizablePaths } = readRecognizableTestSurface(root);
  const sources = recognizablePaths.map((path) => {
    const stats = statSync(join(root, path), { bigint: true });
    return { path, size: stats.size.toString(10), modifiedNanoseconds: stats.mtimeNs.toString(10) };
  });
  return canonicalDomainHash(TEST_SURFACE_FINGERPRINT_HASH_DOMAIN, {
    sources,
    dispositionManifest: sha256(readFileSync(join(root, TEST_DISCOVERY.dispositionRegistry.manifestPath))),
    inventory: sha256(readFileSync(join(root, INVENTORY_PATH))),
    rootPolicy: sha256(readFileSync(join(root, ROOT_POLICY_PATH))),
    // The git-tracked recognizable set is part of the fingerprint because it
    // is an input to the conservation identity. Without it, `git rm --cached`
    // on a test file moves the identity and moves nothing the fingerprint
    // watches, so the auto-heal would skip the regeneration that would have
    // refused — a gate that is only consulted when it already agrees.
    gitRecognizable: canonicalHash(listGitTrackedRecognizableTestPaths(root)),
  });
}

function readTestSourceSnapshotForScope(root: string, scopeValue: TestSurfaceScope): TestSourceSnapshot {
  const scope = parseTestSurfaceScope(scopeValue);
  const { before, recognizablePaths } = readRecognizableTestSurface(root);
  const categorizedPaths = [
    ...scope.canonicalNodeSourceIds,
    ...scope.qualifiedExternalSourceIds,
    ...scope.pendingExternalSourceIds,
    ...scope.nonTestFixtureSourceIds,
    ...scope.unsupportedSourceIds,
  ].toSorted(compareUtf8Bytes);
  if (canonicalHash(categorizedPaths) !== canonicalHash(recognizablePaths)) {
    throw new Error("test inventory recognizable source scope is stale");
  }
  return readCanonicalTestSources(root, before, recognizablePaths, scope);
}

function readRecognizableTestSurface(root: string): Readonly<{
  before: readonly SafeRepositoryTreeEntry[];
  recognizablePaths: readonly string[];
}> {
  const before = testTree(root);
  const recognizableNonFiles = before.filter((entry) =>
    entry.kind !== "file" && recognizableTestSourceLanguage(entry.path) !== undefined
  );
  if (recognizableNonFiles.length > 0) {
    throw new Error(`test inventory source path is invalid: ${recognizableNonFiles[0]!.path}`);
  }
  // ONE OWNER FOR THE PER-PATH DECISION. `testTree` prunes excluded
  // directories during traversal, which is a speed decision; whether a given
  // path is in scope is decided by `isScannedRecognizableTestSource`, which the
  // git-index side applies too. Two copies of this rule is how the liveness
  // refusal came to be judged against 21 files the suite can never run.
  const recognizablePaths = before.filter((entry) =>
    entry.kind === "file" && isScannedRecognizableTestSource(entry.path)
  ).map((entry) => entry.path);
  return deepFreeze({ before, recognizablePaths });
}

/**
 * The single owner of the recognizable test-surface file set. Returns the
 * repository-relative paths of every recognizable test source the inventory
 * considers in-scope, applying the same walk (`listSafeRepositoryTree` with
 * `repositoryScanExclusions`) and the same per-path filters
 * (`shouldExcludeExperiment` + `recognizableTestSourceLanguage`) as the
 * inventory builder itself.
 *
 * Consumers that need "which test files count" — the disposition auto-heal in
 * `scripts/run-tests.ts`, the fingerprint in this module, the scope builder
 * — MUST go through this function instead of reimplementing the walk + filters.
 * Sharing one owner means the coverage check and the auto-add check can never
 * drift: adding a new exclusion rule is one edit here, not a parallel edit in
 * every consumer.
 */
export function listRecognizableTestPaths(root: string): readonly string[] {
  return readRecognizableTestSurface(root).recognizablePaths;
}

/**
 * Every recognizable test source THE GIT INDEX holds, repository-relative.
 *
 * This is the one input to the conservation identity that no value in
 * `root-policy.ts` can move. `listRecognizableTestPaths` above walks the disk
 * through this repository's own exclusion policy, so it answers the same
 * question the policy already decided; `git ls-files` answers it from a file
 * `git` writes. When the two disagree, THAT is the finding.
 *
 * `-z` because NUL is the only byte a path cannot contain: the newline form
 * splits a filename holding a newline in half and silently shrinks the
 * universe, which is the shape of every wrong count in this project.
 */
export function listGitTrackedRecognizableTestPaths(root: string): readonly string[] {
  const paths = gitTrackedRecognizableTestPaths(root);
  if (paths === undefined) {
    throw new Error(
      `${root} is not a git working tree, so the conservation identity has no independent instrument here.`,
    );
  }
  return paths;
}

/**
 * Recognizable test sources ON DISK that the git index does not hold.
 *
 * The conservation identity refuses a registry that names an untracked
 * source ("a clone does not contain them"), and the coverage gate refuses a
 * registry that omits a recognizable source on disk — so an untracked test
 * file can satisfy neither, and every run that meets one is refused. This
 * names them up front, so the disposition auto-heal can refuse BEFORE it
 * writes anything instead of registering them and leaving the refusal to a
 * later step. Empty where `root` has no git instrument (the fixture copies),
 * for the reason `gitTrackedRecognizableTestPaths` gives.
 */
export function listUntrackedRecognizableTestPaths(root: string): readonly string[] {
  const tracked = gitTrackedRecognizableTestPaths(resolve(root));
  if (tracked === undefined) return [];
  const trackedSet = new Set(tracked);
  return listRecognizableTestPaths(root).filter((path) => !trackedSet.has(path));
}

/**
 * The same set, or `undefined` when `root` is NOT A GIT WORKING TREE AT ALL.
 *
 * ── WHY THIS DISTINCTION IS EXPLICIT AND NOT A SKIP ──────────────────────
 *
 * "git tracks nothing" and "there is no git here" are different facts and
 * only one of them is a collapse. The whole-repository fixtures under
 * `.bridlewise/test-fixtures/` are copies with no `.git`, so a refusal that
 * could not tell them apart would have to be skipped for a fixture — and a
 * refusal with a skip in it is a refusal that gets skipped in production the
 * first time it is inconvenient.
 *
 * So the absence is RETURNED rather than swallowed, the caller records it in
 * its status payload, and a test asserts that the REAL repository reports
 * `verified` and never `unavailable`. An empty index in a tree that IS
 * version controlled remains a refusal, because that is the collapse.
 */
function gitTrackedRecognizableTestPaths(root: string): readonly string[] | undefined {
  // `--show-toplevel` and not `--is-inside-work-tree`: the fixtures live UNDER
  // this repository (`.bridlewise/test-fixtures/...`), so git walks up and
  // cheerfully answers "yes, inside a work tree" for a directory it tracks
  // nothing in. The question is whether git HAS AN INDEX THAT TRACKS FILES
  // HERE, and `--is-inside-work-tree` does not ask it.
  //
  // RE-DERIVED AT THE MONOREPO ASSEMBLY (2026-07-30). This used to require
  // `toplevel === root`, which was the same question while this package was
  // its own repository. It is now `engine/` inside a larger one, so the
  // equality answered "not a work tree" for a tree whose every file git
  // tracks — and the conservation identity, the one instrument this policy
  // cannot influence, went `unavailable` on the real repository. An identity
  // that reports "no instrument" on the tree it exists to measure is the
  // vacuous shape the identity itself was written to refuse.
  //
  // So the toplevel is still REQUIRED to exist (no git, no instrument), and
  // the fixture case is caught where it actually shows: a directory git
  // tracks nothing in lists nothing. `NESTED` distinguishes the two empty
  // answers below, because an empty listing at the TOP of a work tree is a
  // broken index and an empty listing in a nested directory is a fixture.
  const toplevel = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" });
  if (toplevel.status !== 0) return undefined;
  const nested = resolve(toplevel.stdout.trim()) !== resolve(root);

  const patterns = ROOT_POLICY.verification.testDiscovery.recognizableSourcePatterns;
  const matchers = [
    new RegExp(patterns.javaScriptTypeScript, "u"),
    new RegExp(patterns.python, "u"),
  ];
  // Present tracked paths: an unstaged deletion of a test is absent, not a
  // test the walk lost (the same population the source walk's oracle uses).
  const tracked = presentTrackedFiles(root) ?? [];
  if (tracked.length === 0) {
    // A nested directory git tracks nothing in is the fixture case — the one
    // the toplevel comparison used to catch. It has no instrument, which is
    // different from having a broken one.
    if (nested) return undefined;
    throw new Error(
      `git tracks no files under ${root}; an empty answer from an index that EXISTS is a refusal, ` +
      `never an empty population.`,
    );
  }
  // Every recognizable test source the engine tracks, wherever it lies: a
  // test-shaped file is accounted for (qualified, or dispositioned), never
  // subtracted by a branch-shaped rule (the floor-byte subtraction retired
  // with the floor, PROMO-4: no recognizable source lives in the evidence
  // archive, and one that did would have to be accounted for).
  return tracked
    .filter((path) => matchers.some((matcher) => matcher.test(path)))
    .toSorted(compareUtf8Bytes);
}

function readCanonicalTestSources(
  root: string,
  before: readonly SafeRepositoryTreeEntry[],
  recognizablePaths: readonly string[],
  scope: TestSurfaceScope,
): TestSourceSnapshot {
  const entryByPath = new Map(before.map((entry) => [entry.path, entry]));
  const candidates = scope.canonicalNodeSourceIds.map((path) => {
    const entry = entryByPath.get(path);
    if (entry?.kind !== "file") throw new Error(`qualified test source is unavailable: ${path}`);
    return entry;
  });
  const sources: TestSourceRead[] = [];
  for (const candidate of candidates) {
    if (candidate.kind !== "file" || !isQualifiedCanonicalNodeTestSource(candidate.path)) {
      throw new Error(`test inventory source path is invalid: ${candidate.path}`);
    }
    const read = readSafeRepositoryFile(root, candidate.path, TEST_DISCOVERY.maximumSourceBytes);
    if (read.identityHash !== candidate.identityHash) {
      throw new Error(`test inventory source changed during discovery: ${candidate.path}`);
    }
    sources.push(Object.freeze({
      sourceId: candidate.path,
      bytes: read.bytes,
      sourceHash: sha256(read.bytes),
    }));
  }
  const after = testTree(root);
  if (canonicalHash(before) !== canonicalHash(after)) {
    throw new Error("test inventory source tree changed during discovery");
  }
  return deepFreeze({ scope, recognizablePaths, sources });
}

function loadBoundTestSurfaceManifest(root: string): TestSurfaceDispositionManifest {
  const manifestRead = readSafeRepositoryFile(
    root,
    TEST_DISCOVERY.dispositionRegistry.manifestPath,
    TEST_DISCOVERY.maximumInventoryBytes,
  );
  const manifest = parseTestSurfaceDispositionManifestText(decodeTestSource(
    manifestRead.bytes,
    TEST_DISCOVERY.dispositionRegistry.manifestPath,
  ));
  if (sha256(manifestRead.bytes) !== ROOT_POLICY.verification.testSurfaceDispositionBinding.fileSha256 ||
    manifest.integrityHash !== ROOT_POLICY.verification.testSurfaceDispositionBinding.identityHash) {
    throw new Error("test-surface disposition binding is stale");
  }
  return manifest;
}

/** The repository walk test discovery reads (ONE set of limits and exclusions, the dispositions check included). */
export function testTree(root: string): readonly SafeRepositoryTreeEntry[] {
  return listSafeRepositoryTree(root, ".", {
    maximumDepth: TEST_DISCOVERY.maximumDepth,
    maximumEntries: TEST_DISCOVERY.maximumEntries,
    excludedDirectoryNames: ROOT_POLICY.configuration.repositoryScanExclusions,
    excludedFileNames: ROOT_POLICY.configuration.repositoryScanFileExclusions,
    excludedFileSuffixes: ROOT_POLICY.configuration.repositoryScanFileSuffixExclusions,
    // This repository's experiment directories (unless HARNESS_INCLUDE_EXPERIMENTS opts them in).
    excludedDirectory: shouldExcludeExperiment,
  });
}

function decodeTestSource(bytes: Buffer, sourceId: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`test inventory source is not valid UTF-8: ${sourceId}`);
  }
}

function replacePinnedInventoryHash(source: string, baseInventoryHash: string, nextInventoryHash: string): string {
  const schemaMarker = `    testInventorySchema: "${ROOT_POLICY.verification.testInventorySchema}",`;
  const marker = `    testInventoryHash: "${baseInventoryHash}",`;
  const schemaIndex = source.indexOf(schemaMarker);
  const index = source.indexOf(marker);
  if (schemaIndex < 0 || source.indexOf(schemaMarker, schemaIndex + schemaMarker.length) >= 0 ||
    index < schemaIndex || source.indexOf(marker, index + marker.length) >= 0) {
    throw new Error("root policy inventory base marker is missing, stale, or ambiguous");
  }
  return source.slice(0, index) + `    testInventoryHash: "${nextInventoryHash}",` +
    source.slice(index + marker.length);
}

function topLevelBindings(body: readonly AstNode[]): ReadonlyMap<string, AstNode> {
  const bindings = new Map<string, AstNode>();
  for (const statement of body) {
    if (statement.type !== "VariableDeclaration" || !Array.isArray(statement.declarations)) continue;
    for (const declaration of statement.declarations) {
      if (!isAstNode(declaration) || !isAstNode(declaration.id) || declaration.id.type !== "Identifier" ||
        typeof declaration.id.name !== "string" || !isAstNode(declaration.init)) continue;
      bindings.set(declaration.id.name, declaration.init);
    }
  }
  return bindings;
}

function testRegistrationAuthority(body: readonly AstNode[]): TestRegistrationAuthority {
  const imported = importedNodeTestRegistrars(body);
  const registrars = new Set<string>(imported.registrars);
  if (imported.registrars.has("test") || !hasTopLevelLexicalBinding(body, "test")) registrars.add("test");
  const wrapperImplementationCalls = new Set<AstNode>();
  for (const statement of body) {
    const wrapper = resolvedNodeTestWrapper(statement, imported.registrars);
    if (wrapper === undefined) continue;
    registrars.add(wrapper.name);
    wrapperImplementationCalls.add(wrapper.implementationCall);
  }
  return Object.freeze({ registrars, wrapperImplementationCalls, describeNames: imported.describeNames });
}

function hasTopLevelLexicalBinding(body: readonly AstNode[], name: string): boolean {
  return body.some((statement) => {
    if (["FunctionDeclaration", "ClassDeclaration"].includes(statement.type)) {
      return isAstNode(statement.id) && statement.id.type === "Identifier" && statement.id.name === name;
    }
    return statement.type === "VariableDeclaration" && Array.isArray(statement.declarations) &&
      statement.declarations.some((declaration) =>
        isAstNode(declaration) && patternBindingNames(declaration.id).includes(name)
      );
  });
}

function importedNodeTestRegistrars(body: readonly AstNode[]): Readonly<{
  registrars: ReadonlySet<string>;
  describeNames: ReadonlySet<string>;
}> {
  const registrars = new Set<string>();
  const describeNames = new Set<string>();
  for (const statement of body) {
    if (statement.type !== "ImportDeclaration" || !isAstNode(statement.source) ||
      statement.source.type !== "StringLiteral" || statement.source.value !== "node:test" ||
      !Array.isArray(statement.specifiers)) continue;
    for (const rawSpecifier of statement.specifiers) {
      if (!isAstNode(rawSpecifier) || !isAstNode(rawSpecifier.local) ||
        rawSpecifier.local.type !== "Identifier" || typeof rawSpecifier.local.name !== "string") continue;
      if (rawSpecifier.type === "ImportDefaultSpecifier") registrars.add(rawSpecifier.local.name);
      if (rawSpecifier.type === "ImportSpecifier" && isAstNode(rawSpecifier.imported)) {
        const importedName = rawSpecifier.imported.type === "Identifier"
          ? rawSpecifier.imported.name
          : rawSpecifier.imported.type === "StringLiteral" ? rawSpecifier.imported.value : undefined;
        if (importedName === "test" || importedName === "it") {
          registrars.add(rawSpecifier.local.name);
        }
        if (importedName === "describe") {
          describeNames.add(rawSpecifier.local.name);
        }
      }
    }
  }
  return Object.freeze({ registrars, describeNames });
}

function resolvedNodeTestWrapper(
  statement: AstNode,
  importedRegistrars: ReadonlySet<string>,
): Readonly<{ name: string; implementationCall: AstNode }> | undefined {
  if (statement.type !== "FunctionDeclaration" || !isAstNode(statement.id) ||
    statement.id.type !== "Identifier" || typeof statement.id.name !== "string" ||
    !Array.isArray(statement.params) || statement.params.length < 2 ||
    !isAstNode(statement.params[0]) || statement.params[0].type !== "Identifier" ||
    typeof statement.params[0].name !== "string" || !isAstNode(statement.body)) return undefined;
  const parameterNames = new Set(statement.params.flatMap((parameter) => patternBindingNames(parameter)));
  const calls = collectTestCalls(
    [statement.body],
    importedRegistrars,
    new Set(),
    parameterNames,
  );
  if (calls.length !== 1) return undefined;
  const call = calls[0]!;
  const first = callFirstArgument(call);
  if (first.type !== "Identifier" || first.name !== statement.params[0].name ||
    !Array.isArray(call.arguments) || call.arguments.length < 2 || !isAstNode(call.arguments[1]) ||
    !["ArrowFunctionExpression", "FunctionExpression"].includes(call.arguments[1].type)) return undefined;
  return Object.freeze({ name: statement.id.name, implementationCall: call });
}

/**
 * Every test registration call under `values`, shadow-aware: a registrar name
 * rebound by a parameter or loop binding is not a registration.
 *
 * It also REFUSES a subtest registered through the test context
 * (`test("x", (t) => t.test(...))`): that test runs inside another test's
 * body, the inventory cannot name it, and the run would be refused as
 * `lifecycle-invalid` after every file executed. The context binding is the
 * registration callback's first parameter, tracked with the same shadowing
 * rules, so `lines.some((t) => t.test(line))` inside a test body (a regex
 * named `t`) is not mistaken for one. Node's `TestContext` exposes `test`
 * only, so that is the one method refused.
 */
function collectTestCalls(
  values: readonly unknown[],
  registrars: ReadonlySet<string>,
  excludedCalls: ReadonlySet<AstNode>,
  initiallyShadowed: ReadonlySet<string> = new Set(),
): AstNode[] {
  const calls: AstNode[] = [];
  const visit = (value: unknown, shadowed: ReadonlySet<string>, contexts: ReadonlySet<string>): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, shadowed, contexts);
      return;
    }
    if (!isAstNode(value)) return;
    if (value.type === "ForOfStatement" && isAstNode(value.left)) {
      visit(value.right, shadowed, contexts);
      const bound = patternBindingNames(value.left);
      visit(value.body, withShadowed(shadowed, bound), withoutNames(contexts, bound));
      return;
    }
    if (["ArrowFunctionExpression", "FunctionDeclaration", "FunctionExpression"].includes(value.type)) {
      const parameters = Array.isArray(value.params)
        ? value.params.flatMap((parameter) => patternBindingNames(parameter))
        : [];
      visit(value.body, withShadowed(shadowed, parameters), withoutNames(contexts, parameters));
      return;
    }
    if (value.type === "CallExpression" && isAstNode(value.callee) && (
      (value.callee.type === "MemberExpression" && isAstNode(value.callee.object) &&
        value.callee.object.type === "Identifier" && contexts.has(String(value.callee.object.name)) &&
        memberPropertyName(value.callee) === "test") ||
      (value.callee.type === "Identifier" && contexts.has(`${CONTEXT_METHOD_PREFIX}${String(value.callee.name)}`)))) {
      throw new Error("subtest registration through the test context is not statically modeled");
    }
    if (value.type === "CallExpression" && isAstNode(value.callee) && value.callee.type === "Identifier" &&
      typeof value.callee.name === "string" && registrars.has(value.callee.name) &&
      !shadowed.has(value.callee.name) && !excludedCalls.has(value)) {
      calls.push(value);
      for (const argument of Array.isArray(value.arguments) ? value.arguments : []) {
        const context = isAstNode(argument) && ["ArrowFunctionExpression", "FunctionExpression"].includes(argument.type) &&
          Array.isArray(argument.params) && isAstNode(argument.params[0])
          ? contextBindingOf(argument.params[0])
          : undefined;
        if (context === undefined || !isAstNode(argument)) {
          visit(argument, shadowed, contexts);
          continue;
        }
        const parameters = (argument.params as unknown[]).flatMap((parameter) => patternBindingNames(parameter));
        visit(argument.body, withShadowed(shadowed, parameters), new Set([...withoutNames(contexts, parameters), context]));
      }
      return;
    }
    for (const child of astChildren(value)) visit(child, shadowed, contexts);
  };
  visit(values, initiallyShadowed, new Set());
  return calls;
}

/** Marks a context entry that is the context's `test` METHOD bound to a name (`({ test: sub })`). */
const CONTEXT_METHOD_PREFIX = "method:";

/** The test-context binding a registration callback's first parameter creates, if any. */
function contextBindingOf(parameter: AstNode): string | undefined {
  if (parameter.type === "Identifier") return String(parameter.name);
  if (parameter.type !== "ObjectPattern" || !Array.isArray(parameter.properties)) return undefined;
  for (const property of parameter.properties) {
    if (!isAstNode(property) || property.type !== "ObjectProperty" || !isAstNode(property.key) ||
      property.key.type !== "Identifier" || property.key.name !== "test" || !isAstNode(property.value)) continue;
    const bound = property.value.type === "AssignmentPattern" ? property.value.left : property.value;
    if (isAstNode(bound) && bound.type === "Identifier") return `${CONTEXT_METHOD_PREFIX}${String(bound.name)}`;
  }
  return undefined;
}

function withoutNames(base: ReadonlySet<string>, names: readonly string[]): ReadonlySet<string> {
  const removed = new Set(names.flatMap((name) => [name, `${CONTEXT_METHOD_PREFIX}${name}`]));
  if (![...base].some((name) => removed.has(name))) return base;
  return new Set([...base].filter((name) => !removed.has(name)));
}

function expressionTestCall(
  statement: AstNode,
  registrars: ReadonlySet<string>,
): AstNode | undefined {
  if (statement.type !== "ExpressionStatement" || !isAstNode(statement.expression)) return undefined;
  const expression = statement.expression;
  return expression.type === "CallExpression" && isAstNode(expression.callee) &&
    expression.callee.type === "Identifier" && typeof expression.callee.name === "string" &&
    registrars.has(expression.callee.name) ? expression : undefined;
}

function expressionDescribeCall(
  statement: AstNode,
  describeNames: ReadonlySet<string>,
): AstNode | undefined {
  if (statement.type !== "ExpressionStatement" || !isAstNode(statement.expression)) return undefined;
  const expression = statement.expression;
  if (expression.type !== "CallExpression" || !isAstNode(expression.callee) ||
    expression.callee.type !== "Identifier" || typeof expression.callee.name !== "string" ||
    !describeNames.has(expression.callee.name)) return undefined;
  if (!Array.isArray(expression.arguments) || expression.arguments.length < 2 ||
    !isAstNode(expression.arguments[1]) ||
    !["ArrowFunctionExpression", "FunctionExpression"].includes(expression.arguments[1].type)) return undefined;
  return expression;
}

function modelDescribeCallback(
  describeCall: AstNode,
  authority: TestRegistrationAuthority,
  names: string[],
  modeledCalls: Set<AstNode>,
  bindings: ReadonlyMap<string, AstNode>,
  prefix: string = "",
): void {
  if (!Array.isArray(describeCall.arguments) || describeCall.arguments.length < 2 ||
    !isAstNode(describeCall.arguments[1]) ||
    !["ArrowFunctionExpression", "FunctionExpression"].includes(describeCall.arguments[1].type)) return;
  const callback = describeCall.arguments[1];
  if (!isAstNode(callback.body)) return;
  const describeName = evaluateTestName(callFirstArgument(describeCall), new Map());
  const qualifiedPrefix = prefix ? `${prefix} > ${describeName}` : describeName;
  const innerStatements = callback.body.type === "BlockStatement" && Array.isArray(callback.body.body)
    ? callback.body.body.filter(isAstNode)
    : [callback.body].filter(isAstNode);
  // Build the binding environment visible inside the describe callback: the
  // enclosing bindings (top-level consts + outer describe locals) plus the
  // const declarations directly in this describe body. A for...of inside the
  // describe can reference any of these as its iterable.
  const describeBindings = new Map<string, AstNode>(bindings);
  for (const [name, init] of topLevelBindings(innerStatements)) describeBindings.set(name, init);
  for (const innerStatement of innerStatements) {
    const innerCall = expressionTestCall(innerStatement, authority.registrars);
    if (innerCall) {
      assertModeledRegistrationCapacity(names.length, 1);
      names.push(`${qualifiedPrefix} > ${evaluateTestName(callFirstArgument(innerCall), new Map())}`);
      modeledCalls.add(innerCall);
      continue;
    }
    const innerDescribe = expressionDescribeCall(innerStatement, authority.describeNames);
    if (innerDescribe) {
      modelDescribeCallback(innerDescribe, authority, names, modeledCalls, describeBindings, qualifiedPrefix);
      continue;
    }
    if (innerStatement.type === "ForOfStatement") {
      modelForOfRegistrations(innerStatement, authority, describeBindings, names, modeledCalls, `${qualifiedPrefix} > `);
    }
  }
}

/**
 * The one owner of `for...of` registration modeling, shared by the top level
 * and every `describe` body.
 *
 * The loop body must hold exactly one modeled registration. It is either
 * reached directly or through a chain of directly nested `for...of` loops, one
 * per statement level, each over its own static iterable; every level binds
 * its pattern into the name environment, so a nested loop models the static
 * cartesian product of its levels in source order. A loop that registers
 * nothing is a data-building loop and contributes no names, so non-test loops
 * (for example parsing manifest entries) never force the closed static
 * iterable evaluator to model values it was never meant to handle.
 *
 * What stays refused is anything the test file's own bytes cannot decide: an
 * iterable that is imported, computed, spread or called, a registration
 * nested under a non-loop construct whose binding the name needs, and more
 * nesting levels than the configured static evaluation depth.
 */
function modelForOfRegistrations(
  statement: AstNode,
  authority: TestRegistrationAuthority,
  bindings: ReadonlyMap<string, AstNode>,
  names: string[],
  modeledCalls: Set<AstNode>,
  prefix: string,
): void {
  const call = forOfRegistrationCall(statement, authority, new Set());
  if (call === undefined) return;
  modeledCalls.add(call);
  const visit = (loop: AstNode, outer: ReadonlyMap<string, StaticLoopValue>, depth: number): void => {
    if (depth > TEST_DISCOVERY.maximumStaticEvaluationDepth) {
      throw new Error("test loop nesting exceeds the configured static evaluation depth ceiling");
    }
    const nested = nestedRegistrationLoop(loop, call, authority, new Set(outer.keys()));
    // The iterable is evaluated against FILE-LEVEL bindings; an inner loop
    // whose iterable reads an OUTER loop binding would be evaluated against
    // the wrong value (a file-level name the loop variable shadows) and name
    // tests that never run. Refused, so the file is named here.
    if (isAstNode(loop.right) && referencedIdentifiers(loop.right).some((name) => outer.has(name))) {
      throw new Error("test loop iterable depends on an outer loop binding and is not statically modeled");
    }
    for (const value of forOfStaticValues(loop.right, bindings)) {
      const environment = new Map([...outer, ...forOfBindingEnvironment(loop, value)]);
      if (nested !== undefined) {
        visit(nested, environment, depth + 1);
        continue;
      }
      assertModeledRegistrationCapacity(names.length, 1);
      names.push(`${prefix}${evaluateTestName(callFirstArgument(call), environment)}`);
    }
  };
  visit(statement, new Map(), 0);
}

function forOfRegistrationCall(
  statement: AstNode,
  authority: TestRegistrationAuthority,
  outerShadowed: ReadonlySet<string>,
): AstNode | undefined {
  const loopCalls = collectTestCalls(
    isAstNode(statement.body) ? [statement.body] : [],
    authority.registrars,
    authority.wrapperImplementationCalls,
    withShadowed(outerShadowed, patternBindingNames(forOfBindingPattern(statement))),
  );
  if (loopCalls.length === 0) return undefined;
  if (loopCalls.length !== 1) throw new Error("test loop must contain exactly one modeled test registration");
  return loopCalls[0]!;
}

/** The directly nested `for...of` statement that owns `call`, if the loop body has one. */
function nestedRegistrationLoop(
  loop: AstNode,
  call: AstNode,
  authority: TestRegistrationAuthority,
  outerShadowed: ReadonlySet<string>,
): AstNode | undefined {
  if (!isAstNode(loop.body)) return undefined;
  const statements = loop.body.type === "BlockStatement" && Array.isArray(loop.body.body)
    ? loop.body.body.filter(isAstNode)
    : [loop.body];
  const shadowed = withShadowed(outerShadowed, patternBindingNames(forOfBindingPattern(loop)));
  return statements.find((statement) =>
    statement.type === "ForOfStatement" && forOfRegistrationCall(statement, authority, shadowed) === call
  );
}

/** Every identifier read anywhere under `node` (property keys of member access excluded). */
function referencedIdentifiers(node: AstNode): readonly string[] {
  const names: string[] = [];
  const pending: AstNode[] = [node];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.type === "Identifier" && typeof current.name === "string") names.push(current.name);
    for (const child of astChildren(current)) {
      if (current.type === "MemberExpression" && current.computed !== true && child === current.property) continue;
      pending.push(child);
    }
  }
  return names;
}

function withShadowed(base: ReadonlySet<string>, additions: readonly string[]): ReadonlySet<string> {
  if (additions.length === 0) return base;
  return new Set([...base, ...additions]);
}

function callFirstArgument(call: AstNode): AstNode {
  if (!Array.isArray(call.arguments) || !isAstNode(call.arguments[0])) {
    throw new Error("test registration has no static first argument");
  }
  return call.arguments[0];
}

function forOfBindingPattern(statement: AstNode): AstNode {
  if (!isAstNode(statement.left) || statement.left.type !== "VariableDeclaration" ||
    !Array.isArray(statement.left.declarations) || statement.left.declarations.length !== 1) {
    throw new Error("test loop binding is not statically modeled");
  }
  const declaration = statement.left.declarations[0];
  if (!isAstNode(declaration) || !isAstNode(declaration.id)) {
    throw new Error("test loop identifier is not statically modeled");
  }
  return declaration.id;
}

function forOfBindingEnvironment(
  statement: AstNode,
  value: StaticLoopValue,
): ReadonlyMap<string, StaticLoopValue> {
  const pattern = forOfBindingPattern(statement);
  const environment = new Map<string, StaticLoopValue>();
  bindStaticPattern(pattern, value, environment);
  return environment;
}

function bindStaticPattern(
  pattern: AstNode,
  value: StaticLoopValue,
  environment: Map<string, StaticLoopValue>,
): void {
  if (pattern.type === "Identifier" && typeof pattern.name === "string") {
    environment.set(pattern.name, value);
    return;
  }
  if (pattern.type === "ArrayPattern" && Array.isArray(pattern.elements) && Array.isArray(value) &&
    pattern.elements.length === value.length) {
    for (const [index, element] of pattern.elements.entries()) {
      if (!isAstNode(element)) throw new Error("test loop destructuring hole is not statically modeled");
      bindStaticPattern(element, value[index]!, environment);
    }
    return;
  }
  if (pattern.type === "ObjectPattern" && Array.isArray(pattern.properties) &&
    isStaticLoopRecord(value)) {
    for (const property of pattern.properties) {
      if (!isAstNode(property) || property.type !== "ObjectProperty" || property.computed === true ||
        !isAstNode(property.value)) throw new Error("test loop object pattern is not statically modeled");
      const key = objectPropertyName(property);
      const nested = value[key];
      if (nested === undefined) throw new Error("test loop object pattern key is unavailable");
      bindStaticPattern(property.value, nested, environment);
    }
    return;
  }
  throw new Error("test loop destructuring is not statically modeled");
}

function patternBindingNames(value: unknown): readonly string[] {
  if (!isAstNode(value)) return [];
  if (value.type === "Identifier" && typeof value.name === "string") return [value.name];
  if (value.type === "VariableDeclaration" && Array.isArray(value.declarations)) {
    return value.declarations.flatMap((declaration) =>
      isAstNode(declaration) ? patternBindingNames(declaration.id) : []
    );
  }
  if (value.type === "ArrayPattern" && Array.isArray(value.elements)) {
    return value.elements.flatMap(patternBindingNames);
  }
  if (value.type === "ObjectPattern" && Array.isArray(value.properties)) {
    return value.properties.map((property) =>
      isAstNode(property) && property.type === "ObjectProperty" ? property.value : property
    ).flatMap(patternBindingNames);
  }
  if (value.type === "AssignmentPattern") return patternBindingNames(value.left);
  if (value.type === "RestElement") return patternBindingNames(value.argument);
  return [];
}

function forOfStaticValues(value: unknown, bindings: ReadonlyMap<string, AstNode>): readonly StaticLoopValue[] {
  const budget: StaticEvaluationBudget = { remaining: TEST_DISCOVERY.maximumEntries };
  return evaluateStaticForOfValues(value, bindings, budget, new Set(), 0);
}

function evaluateStaticForOfValues(
  value: unknown,
  bindings: ReadonlyMap<string, AstNode>,
  budget: StaticEvaluationBudget,
  resolvingBindings: ReadonlySet<string>,
  wrapperDepth: number,
): readonly StaticLoopValue[] {
  if (!isAstNode(value)) throw new Error("test loop iterable is not statically modeled");
  if (wrapperDepth > TEST_DISCOVERY.maximumStaticEvaluationDepth) {
    throw new Error("test loop iterable exceeds the configured static evaluation depth ceiling");
  }
  if (["TSAsExpression", "TSSatisfiesExpression", "TypeCastExpression"].includes(value.type) &&
    isAstNode(value.expression)) {
    return evaluateStaticForOfValues(
      value.expression,
      bindings,
      budget,
      resolvingBindings,
      wrapperDepth + 1,
    );
  }
  if (value.type === "ArrayExpression" && Array.isArray(value.elements)) {
    return value.elements.map((element) => staticLoopValue(element, 0, budget));
  }
  if (value.type === "Identifier" && typeof value.name === "string") {
    if (resolvingBindings.has(value.name)) throw new Error("test loop array binding is cyclic");
    const bound = bindings.get(value.name);
    if (!bound) {
      throw new Error("test loop array binding is not statically modeled");
    }
    return evaluateStaticForOfValues(
      bound,
      bindings,
      budget,
      new Set([...resolvingBindings, value.name]),
      wrapperDepth + 1,
    );
  }
  const keysTarget = objectKeysTarget(value);
  if (keysTarget) {
    const bound = bindings.get(keysTarget);
    if (!bound || bound.type !== "ObjectExpression" || !Array.isArray(bound.properties)) {
      throw new Error("test catalog binding is not a static object");
    }
    const propertyNames = bound.properties.map((property) => {
      if (!isAstNode(property) || property.type !== "ObjectProperty" || property.computed === true) {
        throw new Error("test catalog property is not static");
      }
      return objectPropertyName(property);
    });
    if (new Set(propertyNames).size !== propertyNames.length) {
      throw new Error("test catalog property is duplicated");
    }
    return propertyNames.toSorted(compareUtf8Bytes);
  }
  throw new Error("test loop iterable is not statically modeled");
}

function positiveStaticIntegerLoop(statement: AstNode): Readonly<{ binding: string; values: readonly number[] }> {
  if (!isAstNode(statement.init) || statement.init.type !== "VariableDeclaration" || statement.init.kind !== "let" ||
    !Array.isArray(statement.init.declarations) || statement.init.declarations.length !== 1) {
    throw new Error("numeric test loop initializer is not a single static let binding");
  }
  const declaration = statement.init.declarations[0];
  if (!isAstNode(declaration) || !isAstNode(declaration.id) || declaration.id.type !== "Identifier" ||
    typeof declaration.id.name !== "string") {
    throw new Error("numeric test loop identifier is not statically modeled");
  }
  const binding = declaration.id.name;
  const start = positiveIntegerLiteral(declaration.init, "numeric test loop start");
  if (!isAstNode(statement.test) || statement.test.type !== "BinaryExpression" ||
    !["<", "<="].includes(String(statement.test.operator)) ||
    !isIdentifierNamed(statement.test.left, binding)) {
    throw new Error("numeric test loop condition is not a static ascending bound");
  }
  const end = positiveIntegerLiteral(statement.test.right, "numeric test loop bound");
  if (!isUnitIncrement(statement.update, binding)) {
    throw new Error("numeric test loop update is not an exact unit increment");
  }
  const exclusiveEnd = statement.test.operator === "<=" ? end + 1 : end;
  if (!Number.isSafeInteger(exclusiveEnd) || exclusiveEnd <= start) {
    throw new Error("numeric test loop must have at least one positive static iteration");
  }
  const iterationCount = exclusiveEnd - start;
  if (iterationCount > TEST_DISCOVERY.maximumEntries) {
    throw new Error("numeric test loop exceeds the configured inventory entry ceiling");
  }
  return {
    binding,
    values: Object.freeze(Array.from({ length: iterationCount }, (_, offset) => start + offset)),
  };
}

function positiveIntegerLiteral(value: unknown, label: string): number {
  if (!isAstNode(value) || value.type !== "NumericLiteral" || typeof value.value !== "number" ||
    !Number.isSafeInteger(value.value) || value.value <= 0) {
    throw new Error(`${label} is not a positive safe integer literal`);
  }
  return value.value;
}

function isUnitIncrement(value: unknown, binding: string): boolean {
  if (!isAstNode(value)) return false;
  if (value.type === "UpdateExpression") {
    return value.operator === "++" && isIdentifierNamed(value.argument, binding);
  }
  return value.type === "AssignmentExpression" && value.operator === "+=" &&
    isIdentifierNamed(value.left, binding) && isAstNode(value.right) && value.right.type === "NumericLiteral" &&
    value.right.value === 1;
}

function isIdentifierNamed(value: unknown, name: string): boolean {
  return isAstNode(value) && value.type === "Identifier" && value.name === name;
}

function directLoopTestCalls(
  value: unknown,
  registrars: ReadonlySet<string>,
  shadowed: ReadonlySet<string>,
): readonly AstNode[] {
  if (!isAstNode(value) || value.type !== "BlockStatement" || !Array.isArray(value.body) || value.body.length === 0) {
    throw new Error("numeric test loop body is not a nonempty static registration block");
  }
  const calls = value.body.map((statement) => {
    if (!isAstNode(statement)) return undefined;
    const call = expressionTestCall(statement, registrars);
    if (call !== undefined && isAstNode(call.callee) && call.callee.type === "Identifier" &&
      typeof call.callee.name === "string" && shadowed.has(call.callee.name)) return undefined;
    return call;
  });
  if (calls.some((call) => call === undefined)) {
    throw new Error("numeric test loop body contains an unsupported registration-time side effect");
  }
  for (const call of calls as readonly AstNode[]) {
    if (!Array.isArray(call.arguments) || call.arguments.length !== 2 || !isAstNode(call.arguments[1]) ||
      !["ArrowFunctionExpression", "FunctionExpression"].includes(call.arguments[1].type)) {
      throw new Error("numeric test loop registration arguments contain an unsupported registration-time side effect");
    }
  }
  return calls as readonly AstNode[];
}

function objectKeysTarget(value: AstNode): string | undefined {
  let call = value;
  if (call.type === "CallExpression" && isAstNode(call.callee) && call.callee.type === "MemberExpression" &&
    memberPropertyName(call.callee) === "toSorted" && isAstNode(call.callee.object)) {
    call = call.callee.object;
  }
  if (call.type !== "CallExpression" || !isAstNode(call.callee) || call.callee.type !== "MemberExpression" ||
    memberPropertyName(call.callee) !== "keys" || !isAstNode(call.callee.object) ||
    call.callee.object.type !== "Identifier" || call.callee.object.name !== "Object" ||
    !Array.isArray(call.arguments) || call.arguments.length !== 1 || !isAstNode(call.arguments[0]) ||
    call.arguments[0].type !== "Identifier" || typeof call.arguments[0].name !== "string") return undefined;
  return call.arguments[0].name;
}

function staticLoopValue(value: unknown, depth: number, budget: StaticEvaluationBudget): StaticLoopValue {
  budget.remaining -= 1;
  if (budget.remaining < 0) throw new Error("test case exceeds the configured static evaluation node ceiling");
  if (depth > TEST_DISCOVERY.maximumStaticEvaluationDepth) {
    throw new Error("test case exceeds the configured static evaluation depth ceiling");
  }
  if (!isAstNode(value)) throw new Error("test case is not a static value");
  if (value.type === "StringLiteral" && typeof value.value === "string") return value.value;
  if (value.type === "NumericLiteral" && typeof value.value === "number" &&
    Number.isSafeInteger(value.value)) return value.value;
  if (value.type === "BooleanLiteral" && typeof value.value === "boolean") return value.value;
  if (value.type === "NullLiteral") return null;
  if (["ArrowFunctionExpression", "FunctionExpression"].includes(value.type)) return STATIC_LOOP_OPAQUE;
  if (value.type === "ArrayExpression" && Array.isArray(value.elements)) {
    return Object.freeze(value.elements.map((element) => staticLoopValue(element, depth + 1, budget)));
  }
  return staticObjectValue(value, depth, budget);
}

function staticObjectValue(
  value: unknown,
  depth: number,
  budget: StaticEvaluationBudget,
): Readonly<Record<string, StaticLoopValue>> {
  if (!isAstNode(value) || value.type !== "ObjectExpression" || !Array.isArray(value.properties)) {
    throw new Error("test case is not a static object");
  }
  const output: Record<string, StaticLoopValue> = {};
  for (const property of value.properties) {
    if (!isAstNode(property) || property.type !== "ObjectProperty" || property.computed === true ||
      !isAstNode(property.value)) throw new Error("test case property is not static");
    const name = objectPropertyName(property);
    if (Object.hasOwn(output, name)) throw new Error("test case property is duplicated");
    output[name] = staticLoopValue(property.value, depth + 1, budget);
  }
  return Object.freeze(output);
}

function objectPropertyName(value: unknown): string {
  if (!isAstNode(value) || !isAstNode(value.key)) throw new Error("test catalog property has no static key");
  if (value.key.type === "StringLiteral" && typeof value.key.value === "string") return value.key.value;
  if (value.key.type === "Identifier" && typeof value.key.name === "string") return value.key.name;
  throw new Error("test catalog property key is not static");
}

function evaluateTestName(expression: AstNode, environment: ReadonlyMap<string, StaticLoopValue>): string {
  if (expression.type === "StringLiteral" && typeof expression.value === "string") return expression.value;
  if (expression.type === "Identifier" && typeof expression.name === "string") {
    const rendered = staticScalarName(environment.get(expression.name));
    if (rendered !== undefined) return rendered;
  }
  if (expression.type === "MemberExpression" && isAstNode(expression.object) &&
    expression.object.type === "Identifier" && typeof expression.object.name === "string") {
    const value = environment.get(expression.object.name);
    const property = memberPropertyName(expression);
    if (isStaticLoopRecord(value) && property) {
      const rendered = staticScalarName(value[property]);
      if (rendered !== undefined) return rendered;
    }
  }
  if (expression.type === "TemplateLiteral" && Array.isArray(expression.quasis) &&
    Array.isArray(expression.expressions) && expression.quasis.length === expression.expressions.length + 1) {
    let output = "";
    for (let index = 0; index < expression.quasis.length; index += 1) {
      const quasi = expression.quasis[index];
      if (!isAstNode(quasi) || !isPlainRecord(quasi.value) || typeof quasi.value.cooked !== "string") {
        throw new Error("test name template has an invalid static segment");
      }
      output += quasi.value.cooked;
      if (index < expression.expressions.length) {
        const dynamic = expression.expressions[index];
        if (!isAstNode(dynamic)) throw new Error("test name template expression is not static");
        output += evaluateTestName(dynamic, environment);
      }
    }
    return output;
  }
  throw new Error("test name is not statically modeled");
}

/**
 * A static scalar interpolated into a test name renders exactly as the
 * runtime template literal would (`String(value)`). Every scalar the closed
 * loop evaluator admits (string, safe integer, boolean, null) is renderable;
 * arrays, records and opaque functions are not, because their runtime
 * rendering is not a stable identity.
 */
function staticScalarName(value: StaticLoopValue | undefined): string | undefined {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null
    ? String(value)
    : undefined;
}

function isStaticLoopRecord(value: unknown): value is StaticLoopRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) && value !== STATIC_LOOP_OPAQUE;
}

function memberPropertyName(value: AstNode): string | undefined {
  if (!isAstNode(value.property)) return undefined;
  if (value.property.type === "Identifier" && typeof value.property.name === "string" && value.computed !== true) {
    return value.property.name;
  }
  if (value.property.type === "StringLiteral" && typeof value.property.value === "string") return value.property.value;
  return undefined;
}

function parseInventoryBase(text: string): Readonly<{ inventoryHash: string }> {
  assertNoDuplicateJsonObjectKeys(
    text,
    "Base test inventory contains a duplicate key",
    "test_inventory_base_key_duplicate",
  );
  const inventory = z.union([
    INVENTORY_SCHEMA,
    LEGACY_V1_V2_INVENTORY_SCHEMA,
    LEGACY_V3_INVENTORY_SCHEMA,
  ]).parse(JSON.parse(text) as unknown);
  const expectedHash = inventory.schemaVersion === ROOT_POLICY.verification.testInventorySchema
    ? testInventoryIdentity(inventory.scope, inventory.tests)
    : inventory.schemaVersion === "bridlewise-test-inventory/v3"
      ? canonicalHash({ scope: inventory.scope, tests: inventory.tests })
      : canonicalHash(inventory.tests);
  if (expectedHash !== inventory.inventoryHash) {
    throw new Error("base test inventory hash is invalid");
  }
  return inventory;
}

function isAstNode(value: unknown): value is AstNode {
  return isPlainRecord(value) && typeof value.type === "string";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    // THE REFUSAL'S OWN CODE SURVIVES; IT IS NOT REPLACED BY A GENERIC ONE.
    //
    // Every refusal in `test-surface.ts` carries a specific code —
    // `qualified_test_pattern_dead`, `test_surface_registry_untracked`,
    // `test_surface_pinned_set_moved`, `test_surface_conservation_broken` —
    // and this handler used to flatten all of them into
    // `test_inventory_generation_failed`, leaving the distinction alive only
    // as prose inside `message`. A caller that switches on `error` could not
    // tell a collapsing test surface from a parse failure, and a test that
    // wants to assert WHICH refusal fired had to match English.
    //
    // The generic code is kept as the outer one so existing consumers keep
    // working, and the specific code is carried beside it.
    const message = extractErrorMessage(error);
    const refusal = error instanceof HarnessError ? { refusal: error.code } : {};
    process.stderr.write(`${canonicalJson({
      error: "test_inventory_generation_failed",
      ...refusal,
      message,
    })}\n`);
    process.exitCode = 1;
  }
}
