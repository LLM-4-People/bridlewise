import { existsSync, readFileSync } from "node:fs";
import { atomicWriteFile } from "../filesystem/atomic-write.ts";
import { resolve } from "node:path";

import { canonicalJson, deepFreeze, sha256 } from "../kernel/integrity.ts";
import { InputError } from "../kernel/errors.ts";
import { parseSignedReport } from "./command-result.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { VERIFICATION_PATHS } from "../kernel/verification-paths.ts";
import { buildConfigContract, getConfigContractArtifact } from "../kernel/config-contracts.ts";
import { verifyBindingById } from "./hash-binding-registry.ts";
import { handleError } from "../shared/debug/debug-system.ts";
import { schemaId } from "../kernel/product-identity.ts";

export const AUTO_GENERATOR_SCHEMA_VERSION = schemaId("auto-generator", 1);

export type DispositionBinding = Readonly<{
  fileSha256: string;
  identityHash: string;
  current: Readonly<{ fileSha256: string; identityHash: string }>;
  matches: boolean;
}>;

export type InventoryBinding = Readonly<{
  testInventoryHash: string;
  current: string;
  matches: boolean;
}>;

export type ConfigSchemaBinding = Readonly<{
  schemaHash: string;
  identityHash: string;
  current: Readonly<{ sourceSha256: string; schemaHash: string }>;
  matches: boolean;
}>;

export type AutoGeneratorStep = Readonly<{
  step: string;
  status: "pass" | "drift" | "error";
  message: string;
  details: unknown;
}>;

export type AutoGeneratorReport = Readonly<{
  schemaVersion: typeof AUTO_GENERATOR_SCHEMA_VERSION;
  root: string;
  steps: readonly AutoGeneratorStep[];
  dispositionBinding: DispositionBinding | null;
  inventoryBinding: InventoryBinding | null;
  configSchemaBinding: ConfigSchemaBinding | null;
  allMatch: boolean;
  generatedAt: string;
  integrityHash: string;
}>;

export type AutoGeneratorOptions = Readonly<{
  write?: boolean;
}>;

export function computeDispositionBinding(root: string): DispositionBinding | null {
  const dispositionPath = resolve(root, ROOT_POLICY.verification.testDiscovery.dispositionRegistry.manifestPath);
  if (!existsSync(dispositionPath)) return null;
  const fileBytes = readFileSync(dispositionPath, "utf8");
  const fileSha256 = sha256(fileBytes);
  const parsed = JSON.parse(fileBytes) as { integrityHash?: string };
  const identityHash = typeof parsed.integrityHash === "string" ? parsed.integrityHash : sha256(fileBytes);
  // The expected literals are sourced from the on-disk root policy through the
  // central hash-binding registry. A static ROOT_POLICY import is stale the
  // moment an earlier step in the same process rewrote src/root-policy.ts, so
  // it must never be used as the comparison baseline.
  const currentFile = verifyBindingById(root, "root-policy-disposition-file-sha256");
  const currentIdentity = verifyBindingById(root, "root-policy-disposition-identity-hash");
  return deepFreeze({
    fileSha256,
    identityHash,
    current: deepFreeze({ fileSha256: currentFile.actual, identityHash: currentIdentity.actual }),
    matches: fileSha256 === currentFile.actual && identityHash === currentIdentity.actual,
  });
}

export function computeInventoryBinding(root: string): InventoryBinding | null {
  const inventoryPath = resolve(root, VERIFICATION_PATHS.testInventory);
  if (!existsSync(inventoryPath)) return null;
  const fileBytes = readFileSync(inventoryPath, "utf8");
  const parsed = JSON.parse(fileBytes) as { inventoryHash?: string };
  const testInventoryHash = typeof parsed.inventoryHash === "string" ? parsed.inventoryHash : sha256(fileBytes);
  // File-truthful baseline: read the current on-disk root-policy literal via
  // the hash-binding registry (see computeDispositionBinding).
  const current = verifyBindingById(root, "root-policy-test-inventory-hash").actual;
  return deepFreeze({
    testInventoryHash,
    current,
    matches: testInventoryHash === current,
  });
}

/**
 * The config-contract artifact the ON-DISK root policy declares.
 *
 * The artifact embeds the root policy's `configuration.contract.sourceSha256`
 * pin. A generator step earlier in the same process may have re-pinned it, and
 * the statically imported ROOT_POLICY still holds the old value, so an artifact
 * built from the import would lag one pass behind the policy it sits beside
 * (the defect that made `harness sync` need a second pass). The pin is read
 * through the file-truthful hash-binding registry instead, like every other
 * baseline in this module.
 */
export function currentConfigContractArtifact(root: string): ReturnType<typeof getConfigContractArtifact> {
  const pin = verifyBindingById(root, "root-policy-config-contracts-source-sha256");
  const contract = ROOT_POLICY.configuration.contract;
  // A tree that carries no readable pin (a product-only fixture without the
  // policy file) declares nothing on disk; the imported policy is its only one.
  if (pin.error !== undefined || pin.actual === contract.sourceSha256) return getConfigContractArtifact();
  const sourceSha256 = pin.actual;
  return buildConfigContract({ ...ROOT_POLICY, configuration: { ...ROOT_POLICY.configuration, contract: { ...contract, sourceSha256 } } }).artifact;
}

export function computeConfigSchemaBinding(root: string = process.cwd()): ConfigSchemaBinding {
  const { schemaHash, identityHash } = currentConfigContractArtifact(root);
  const currentContract = ROOT_POLICY.configuration.contract;
  const sourcePath = resolve(root, currentContract.sourcePath);
  let actualSourceSha256: string;
  try {
    actualSourceSha256 = existsSync(sourcePath) ? sha256(readFileSync(sourcePath, "utf8")) : "";
  } catch (e) {handleError(e, { module: "workflow-auto-generator", operation: "catch" });
    actualSourceSha256 = "";
  }
  // File-truthful baseline: read the current on-disk root-policy literal via
  // the hash-binding registry (see computeDispositionBinding).
  const currentSourceSha256 = verifyBindingById(root, "root-policy-config-contracts-source-sha256").actual;
  return deepFreeze({
    schemaHash,
    identityHash,
    current: deepFreeze({ sourceSha256: currentSourceSha256, schemaHash }),
    matches: actualSourceSha256 !== "" && actualSourceSha256 === currentSourceSha256,
  });
}

export function generateAutoGeneratorReport(
  root: string,
  options: AutoGeneratorOptions = {},
): AutoGeneratorReport {
  const steps: AutoGeneratorStep[] = [];

  const dispositionBinding = computeDispositionBinding(root);
  if (dispositionBinding === null) {
    steps.push(deepFreeze({ step: "disposition-binding", status: "error", message: "test-surface disposition file not found", details: null }));
  } else {
    steps.push(deepFreeze({
      step: "disposition-binding",
      status: dispositionBinding.matches ? "pass" : "drift",
      message: dispositionBinding.matches ? "disposition binding matches root policy" : "disposition binding has drifted from root policy",
      details: dispositionBinding,
    }));
    if (options.write && !dispositionBinding.matches) {
      updateRootPolicyBinding(root, "testSurfaceDispositionBinding", {
        fileSha256: dispositionBinding.fileSha256,
        identityHash: dispositionBinding.identityHash,
      });
    }
  }

  const inventoryBinding = computeInventoryBinding(root);
  if (inventoryBinding === null) {
    steps.push(deepFreeze({ step: "inventory-binding", status: "error", message: "test inventory file not found", details: null }));
  } else {
    steps.push(deepFreeze({
      step: "inventory-binding",
      status: inventoryBinding.matches ? "pass" : "drift",
      message: inventoryBinding.matches ? "inventory hash matches root policy" : "inventory hash has drifted from root policy",
      details: inventoryBinding,
    }));
    if (options.write && !inventoryBinding.matches) {
      updateRootPolicyBinding(root, "testInventoryHash", inventoryBinding.testInventoryHash);
    }
  }

  const configSchemaBinding = computeConfigSchemaBinding(root);
  steps.push(deepFreeze({
    step: "config-schema-binding",
    status: configSchemaBinding.matches ? "pass" : "drift",
    message: configSchemaBinding.matches ? "config schema binding matches root policy" : "config schema binding has drifted from root policy",
    details: configSchemaBinding,
  }));

  // The qualification-authority inventory is a VERIFICATION subject (a
  // benchmark manifest under `verification/benchmarks/`). A product-only tree
  // carries no verification tree, so the file is absent BY DESIGN there — the
  // step reports a guided skip, not an error. On a tree that carries the
  // verification surface the file must exist and is hashed.
  const qualificationInventoryPath = resolve(root, "verification/benchmarks/shared/qualification-authority-inventory.mjs");
  const verificationTreePresent = existsSync(resolve(root, "verification"));
  if (existsSync(qualificationInventoryPath)) {
    const fileBytes = readFileSync(qualificationInventoryPath, "utf8");
    steps.push(deepFreeze({
      step: "qualification-authority-inventory",
      status: "pass",
      message: "qualification authority inventory file exists",
      details: deepFreeze({ fileSha256: sha256(fileBytes), byteLength: fileBytes.length }),
    }));
  } else if (!verificationTreePresent) {
    steps.push(deepFreeze({
      step: "qualification-authority-inventory",
      status: "pass",
      message: "no verification tree on this branch (the verification suite lives on the testing branch)",
      details: null,
    }));
  } else {
    steps.push(deepFreeze({
      step: "qualification-authority-inventory",
      status: "error",
      message: "qualification authority inventory file not found",
      details: null,
    }));
  }

  const allMatch = steps.every((step) => step.status === "pass");

  const unsigned = {
    schemaVersion: AUTO_GENERATOR_SCHEMA_VERSION,
    root,
    steps: deepFreeze(steps),
    dispositionBinding,
    inventoryBinding,
    configSchemaBinding,
    allMatch,
    generatedAt: new Date().toISOString(),
  } as const;
  return deepFreeze({ ...unsigned, integrityHash: sha256(canonicalJson(unsigned)) } as AutoGeneratorReport);
}

export function parseAutoGeneratorReport(value: unknown): AutoGeneratorReport {
  return parseSignedReport<AutoGeneratorReport>(value, AUTO_GENERATOR_SCHEMA_VERSION, "auto generator report");
}

function updateRootPolicyBinding(root: string, bindingKey: string, newValue: unknown): void {
  const rootPolicyPath = resolve(root, "src/kernel/root-policy.ts");
  if (!existsSync(rootPolicyPath)) {
    throw new InputError("root policy file not found", "input_error");
  }
  let content = readFileSync(rootPolicyPath, "utf8");
  // Old literals are re-sourced from the on-disk file via the hash-binding
  // registry. The static ROOT_POLICY import holds process-start values and
  // would target the wrong literal after an earlier write in this process.
  if (bindingKey === "testInventoryHash") {
    const oldHash = verifyBindingById(root, "root-policy-test-inventory-hash").actual;
    content = content.replace(
      `testInventoryHash: "${oldHash}"`,
      `testInventoryHash: "${newValue as string}"`,
    );
  } else if (bindingKey === "testSurfaceDispositionBinding") {
    const binding = newValue as { fileSha256: string; identityHash: string };
    const oldFileSha256 = verifyBindingById(root, "root-policy-disposition-file-sha256").actual;
    const oldIdentityHash = verifyBindingById(root, "root-policy-disposition-identity-hash").actual;
    content = content.replace(
      `fileSha256: "${oldFileSha256}"`,
      `fileSha256: "${binding.fileSha256}"`,
    );
    content = content.replace(
      `identityHash: "${oldIdentityHash}"`,
      `identityHash: "${binding.identityHash}"`,
    );
  }
  const writeResult = atomicWriteFile(rootPolicyPath, content);
  if (!writeResult.success) {
    throw new InputError(`Could not write root policy: ${writeResult.reason ?? "unknown"}`, "input_error");
  }
}
