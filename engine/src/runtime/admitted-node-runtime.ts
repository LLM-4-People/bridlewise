import { AsyncLocalStorage } from "node:async_hooks";
import { execPath } from "node:process";

import { HarnessError } from "../kernel/errors.ts";
import { canonicalHash, deepFreeze, sha256 } from "../kernel/integrity.ts";
import { isPromiseLike } from "../shared/type-guards.ts";
import {
  withPinnedProcessExecutable,
  type PinnedProcessExecutable,
} from "../process/pinned-process-internal.ts";
import { ROOT_POLICY, ROOT_POLICY_HASH } from "../kernel/root-policy.ts";
import { schemaId } from "../kernel/product-identity.ts";

const RUNTIME_LAUNCH = ROOT_POLICY.filesystemInfrastructure.runtimeLaunch;
const ADMISSION_CONFIG = RUNTIME_LAUNCH.configuredInternalAdmission;
const ADMISSION_RECORD_SCHEMA_VERSION = schemaId("admitted-node-runtime-record", 1);

export type AdmittedRuntimePrincipal = Readonly<{
  identity: string;
  capabilities: readonly string[];
  sourceAuthority: string;
}>;

export type AdmittedNodeRuntimeRecord = Readonly<{
  schemaVersion: string;
  admittedAt: string;
  principal: AdmittedRuntimePrincipal;
  executableIdentityHash: string;
  admissionClass: string;
  policyHash: string;
  externalBootstrapStatus: string;
  externalBootstrapBlockers: readonly string[];
}>;

export type ConfiguredRuntimeAdmission = Readonly<{
  principal: AdmittedRuntimePrincipal;
  executableSource: string;
  executableMaximumBytes: number;
  mechanismTestOnly: boolean;
}>;

type AdmittedNodeRuntimeState = {
  active: boolean;
  executable: PinnedProcessExecutable;
  principal: AdmittedRuntimePrincipal;
  record: AdmittedNodeRuntimeRecord;
};

const ADMITTED_NODE_RUNTIME = new AsyncLocalStorage<AdmittedNodeRuntimeState>();

function admissionError(code: string, detail: string): HarnessError {
  return new HarnessError("Admitted node runtime operation failed", code, false, {
    detailSha256: sha256(detail),
  });
}

export function configuredRuntimeAdmission(): ConfiguredRuntimeAdmission {
  if (RUNTIME_LAUNCH.callerSuppliedAdmissionAllowed) {
    throw admissionError("runtime_admission_caller_supplied_not_allowed", "callerSuppliedAdmissionAllowed");
  }
  if (ADMISSION_CONFIG === undefined) {
    throw admissionError("runtime_admission_not_configured", "configuredInternalAdmission");
  }
  return deepFreeze({
    principal: ADMISSION_CONFIG.principal,
    executableSource: ADMISSION_CONFIG.runtimeExecutable.source,
    executableMaximumBytes: ADMISSION_CONFIG.runtimeExecutable.maximumBytes,
    mechanismTestOnly: ADMISSION_CONFIG.runtimeExecutable.mechanismTestOnly,
  });
}

export function withAdmittedNodeRuntime<Result>(
  admission: ConfiguredRuntimeAdmission,
  operation: () => Result,
): Result {
  if (ADMITTED_NODE_RUNTIME.getStore() !== undefined) {
    throw admissionError("runtime_admission_nested", "admitted-node-runtime");
  }
  if (admission.mechanismTestOnly) {
    throw admissionError("runtime_admission_mechanism_test_only_not_allowed", "mechanismTestOnly");
  }
  const executablePath = admission.executableSource === "process-exec-path"
    ? execPath
    : admission.executableSource;
  return withPinnedProcessExecutable(
    executablePath,
    admission.executableMaximumBytes,
    false,
    (executable) => {
      const record: AdmittedNodeRuntimeRecord = deepFreeze({
        schemaVersion: ADMISSION_RECORD_SCHEMA_VERSION,
        admittedAt: new Date().toISOString(),
        principal: admission.principal,
        executableIdentityHash: executable.identityHash,
        admissionClass: ADMISSION_CONFIG.admissionClass,
        policyHash: ROOT_POLICY_HASH,
        externalBootstrapStatus: ADMISSION_CONFIG.externalBootstrap.status,
        externalBootstrapBlockers: ADMISSION_CONFIG.externalBootstrap.blockers,
      });
      const state: AdmittedNodeRuntimeState = {
        active: true,
        executable,
        principal: admission.principal,
        record,
      };
      try {
        const result = ADMITTED_NODE_RUNTIME.run(state, operation);
        if (isPromiseLike(result)) {
          return Promise.resolve(result).finally(() => { state.active = false; }) as Result;
        }
        state.active = false;
        return result;
      } catch (error) {
        state.active = false;
        throw error;
      }
    },
  );
}

export function currentAdmittedNodeRuntime(): AdmittedNodeRuntimeState | undefined {
  return ADMITTED_NODE_RUNTIME.getStore();
}

export function currentAdmittedNodeRuntimeRecord(): AdmittedNodeRuntimeRecord | undefined {
  const state = ADMITTED_NODE_RUNTIME.getStore();
  return state === undefined ? undefined : state.record;
}

export function hasAdmittedNodeRuntime(): boolean {
  const state = ADMITTED_NODE_RUNTIME.getStore();
  return state !== undefined && state.active;
}

export function admittedNodeRuntimePrincipal(): AdmittedRuntimePrincipal | undefined {
  const state = ADMITTED_NODE_RUNTIME.getStore();
  return state === undefined ? undefined : state.principal;
}

export function admittedNodeRuntimeExecutable(): PinnedProcessExecutable | undefined {
  const state = ADMITTED_NODE_RUNTIME.getStore();
  return state === undefined ? undefined : state.executable;
}

export function admittedNodeRuntimeAdmissionRecordIdentity(record: AdmittedNodeRuntimeRecord): string {
  return canonicalHash(record);
}
