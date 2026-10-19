import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { deepFreeze, sha256 } from "../kernel/integrity.ts";
import { HarnessError, InputError } from "../kernel/errors.ts";
import { DEFAULT_MAX_REPORTED_VIOLATIONS } from "./workflow-config.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { VERIFICATION_PATHS } from "../kernel/verification-paths.ts";

/**
 * Inventory binding for `collectTestResults`. The canonical inventory owner
 * and generator live in `scripts/test-inventory.ts` (builder layer, which may
 * import `src/`). This module is the `src/`-side consumer of the generated
 * artifact: it validates the pinned inventory against `ROOT_POLICY`, asserts
 * the recorded source snapshot against current file bytes, and reconciles the
 * executed tests against the inventoried (sourceId, name) identities. It never
 * re-derives test names from source — name drift is caught because any source
 * edit changes the pinned `sourceHash`, which the snapshot assertion rejects.
 */


export type TestInventoryBindingEntry = Readonly<{
  id: string;
  sourceId: string;
  sourceHash: string;
  name: string;
}>;

export type TestInventoryBinding = Readonly<{
  inventoryPath: string;
  inventoryHash: string;
  entries: readonly TestInventoryBindingEntry[];
  sourceIds: readonly string[];
  expectedIdsByKey: ReadonlyMap<string, string>;
}>;

export type TestRunObservation = Readonly<{
  tests: readonly Readonly<{
    name: string;
    file: string;
    status: string;
  }>[];
}>;

export type InventoryRunAccounting = Readonly<{
  expectedCount: number;
  discoveredCount: number;
  missingIds: readonly string[];
  unknownTests: readonly string[];
  duplicateTests: readonly string[];
}>;

const HEX_64 = /^[0-9a-f]{64}$/u;
const MAX_REPORTED_VIOLATIONS = DEFAULT_MAX_REPORTED_VIOLATIONS;

/**
 * Load the generated test inventory and bind it to the root-policy pin.
 * Throws `test_inventory_stale` when the inventory file is missing, malformed,
 * or disagrees with the pinned schema/hash in `ROOT_POLICY.verification`.
 */
export function loadTestInventoryBinding(root: string): TestInventoryBinding {
  if (typeof root !== "string" || root.length === 0) {
    throw new InputError("root must be a non-empty string", "input_error");
  }
  const inventoryPath = VERIFICATION_PATHS.testInventory;
  let text: string;
  try {
    text = readFileSync(resolve(root, inventoryPath), "utf8");
  } catch (error) {
    throw new HarnessError(
      `test inventory is unavailable at ${inventoryPath}: ${error instanceof Error ? error.message : "unreadable"}`,
      "test_inventory_stale",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HarnessError("test inventory is not valid JSON", "test_inventory_stale");
  }
  if (typeof value !== "object" || value === null) {
    throw new HarnessError("test inventory must be an object", "test_inventory_stale");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== ROOT_POLICY.verification.testInventorySchema) {
    throw new HarnessError(
      `test inventory schema ${String(record.schemaVersion)} does not match the pinned schema ${ROOT_POLICY.verification.testInventorySchema}`,
      "test_inventory_stale",
    );
  }
  if (typeof record.inventoryHash !== "string" || !HEX_64.test(record.inventoryHash)) {
    throw new HarnessError("test inventory hash is invalid", "test_inventory_stale");
  }
  if (record.inventoryHash !== ROOT_POLICY.verification.testInventoryHash) {
    throw new HarnessError(
      "test inventory is stale: its hash does not match the root-policy pin; run `harness regenerate`",
      "test_inventory_stale",
    );
  }
  if (!Array.isArray(record.tests) || record.tests.length === 0) {
    throw new HarnessError("test inventory contains no tests", "test_inventory_stale");
  }
  const entries: TestInventoryBindingEntry[] = [];
  const expectedIdsByKey = new Map<string, string>();
  const sourceHashesById = new Map<string, string>();
  for (const rawEntry of record.tests) {
    if (typeof rawEntry !== "object" || rawEntry === null) {
      throw new HarnessError("test inventory entry must be an object", "test_inventory_stale");
    }
    const entry = rawEntry as Record<string, unknown>;
    if (typeof entry.id !== "string" || !HEX_64.test(entry.id) ||
      typeof entry.sourceId !== "string" || entry.sourceId.length === 0 ||
      typeof entry.sourceHash !== "string" || !HEX_64.test(entry.sourceHash) ||
      typeof entry.name !== "string" || entry.name.length === 0) {
      throw new HarnessError("test inventory entry is invalid", "test_inventory_stale");
    }
    const key = `${entry.sourceId}\0${entry.name}`;
    if (expectedIdsByKey.has(key)) {
      throw new HarnessError(`test inventory contains a duplicate entry for ${entry.sourceId} "${entry.name}"`, "test_inventory_stale");
    }
    const previousHash = sourceHashesById.get(entry.sourceId);
    if (previousHash !== undefined && previousHash !== entry.sourceHash) {
      throw new HarnessError(`test inventory contains conflicting source hashes for ${entry.sourceId}`, "test_inventory_stale");
    }
    sourceHashesById.set(entry.sourceId, entry.sourceHash);
    expectedIdsByKey.set(key, entry.id);
    entries.push(deepFreeze({ id: entry.id, sourceId: entry.sourceId, sourceHash: entry.sourceHash, name: entry.name }));
  }
  // When the inventory carries a canonical-node scope, the scope's source set
  // must exactly equal the set of sources the entries reference. A scope that
  // covers fewer or more files than the entries is internally inconsistent.
  const scope = record.scope;
  if (typeof scope === "object" && scope !== null) {
    const canonical = (scope as Record<string, unknown>).canonicalNodeSourceIds;
    if (Array.isArray(canonical)) {
      const scopeSet = new Set(canonical);
      if (scopeSet.size !== sourceHashesById.size || ![...sourceHashesById.keys()].every((sourceId) => scopeSet.has(sourceId))) {
        throw new HarnessError("test inventory scope does not match its entries", "test_inventory_stale");
      }
    }
  }
  return deepFreeze({
    inventoryPath,
    inventoryHash: record.inventoryHash,
    entries: deepFreeze(entries),
    sourceIds: deepFreeze([...sourceHashesById.keys()].toSorted()),
    expectedIdsByKey,
  });
}

/**
 * Assert every inventoried source still exists with its recorded byte hash.
 * Run before and after test execution so a test file that was edited,
 * renamed, or deleted after the inventory was generated (or mutated mid-run)
 * fails the command instead of passing silently.
 */
export function assertTestInventoryBindingSourceSnapshot(root: string, binding: TestInventoryBinding): void {
  const sourceHashById = new Map(binding.entries.map((entry) => [entry.sourceId, entry.sourceHash]));
  for (const sourceId of binding.sourceIds) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(resolve(root, sourceId));
    } catch {
      throw new HarnessError(
        `test inventory source is missing: ${sourceId}; run \`harness regenerate\``,
        "test_inventory_stale",
      );
    }
    if (sha256(bytes) !== sourceHashById.get(sourceId)) {
      throw new HarnessError(
        `test inventory source snapshot is stale for ${sourceId}; run \`harness regenerate\``,
        "test_inventory_stale",
      );
    }
  }
}

/**
 * Reconcile an executed test run against the inventory. Every inventoried
 * (sourceId, name) identity must be discovered exactly once, and every
 * discovered non-wrapper test must be inventoried. Returns the accounting on
 * success; throws `test_inventory_run_mismatch` otherwise.
 */
export function assertTestRunMatchesInventory(
  root: string,
  binding: TestInventoryBinding,
  observation: TestRunObservation,
): InventoryRunAccounting {
  const discoveredKeys = new Map<string, number>();
  const unknownTests: string[] = [];
  for (const entry of observation.tests) {
    if (isFileWrapperEntry(root, entry)) continue;
    const key = `${entry.file}\0${entry.name}`;
    if (!binding.expectedIdsByKey.has(key)) {
      unknownTests.push(`${entry.status}:${entry.file}:"${entry.name}"`);
      continue;
    }
    discoveredKeys.set(key, (discoveredKeys.get(key) ?? 0) + 1);
  }
  const duplicateTests = [...discoveredKeys.entries()]
    .filter(([, count]) => count !== 1)
    .map(([key, count]) => `${key} discovered ${count} times`);
  const missingIds = binding.entries
    .filter((entry) => !discoveredKeys.has(`${entry.sourceId}\0${entry.name}`))
    .map((entry) => `${entry.id}:${entry.sourceId}:"${entry.name}"`);
  if (unknownTests.length > 0 || missingIds.length > 0 || duplicateTests.length > 0) {
    throw new HarnessError(
      "test run does not match the test inventory: " +
      `${missingIds.length} missing, ${unknownTests.length} unknown, ${duplicateTests.length} duplicate. ` +
      [
        missingIds.length > 0 ? `missing: ${missingIds.slice(0, MAX_REPORTED_VIOLATIONS).join("; ")}` : "",
        unknownTests.length > 0 ? `unknown: ${unknownTests.slice(0, MAX_REPORTED_VIOLATIONS).join("; ")}` : "",
        duplicateTests.length > 0 ? `duplicates: ${duplicateTests.slice(0, MAX_REPORTED_VIOLATIONS).join("; ")}` : "",
      ].filter((part) => part.length > 0).join(". "),
      "test_inventory_run_mismatch",
    );
  }
  return deepFreeze({
    expectedCount: binding.entries.length,
    discoveredCount: discoveredKeys.size,
    missingIds: deepFreeze([]),
    unknownTests: deepFreeze([]),
    duplicateTests: deepFreeze([]),
  });
}

/**
 * The runner can emit per-file wrapper events whose name is the file path
 * itself (absolute or relative). These are not modeled test registrations and
 * must not be reconciled against inventory identities.
 */
function isFileWrapperEntry(
  root: string,
  entry: Readonly<{ name: string; file: string }>,
): boolean {
  return entry.name === entry.file || entry.name === resolve(root, entry.file);
}
