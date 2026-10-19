import { spawnSync } from "node:child_process";
import { fstatSync, type BigIntStats } from "node:fs";

import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { HarnessError } from "../kernel/errors.ts";
import {
  closePinnedPathChain,
  openPinnedAbsoluteFile,
  pinnedPathIdentityHash,
  samePinnedPathIdentity,
  sameStablePinnedPathIdentity,
} from "../filesystem/pinned-path-internal.ts";
import { canonicalDomainHash, canonicalHash, deepFreeze, isPositiveFinite, sha256, SHA256_HEX_REGEX } from "../kernel/integrity.ts";
import { cryptoDomain } from "../kernel/product-identity.ts";

export type PinnedProcessExecutable = Readonly<{
  identityHash: string;
  mechanismTestOnly: boolean;
}>;

export type PinnedProcessBinding = Readonly<{
  identityHash: string;
}>;

export type PinnedProcessProfile = Readonly<{
  allowedSignals: readonly NodeJS.Signals[];
  allowedStatuses: readonly number[];
  bindingTargets: readonly Readonly<{ id: string; targetDescriptor: number }>[];
  environment: Readonly<Record<string, string>>;
  executablePath: string;
  executableTargetDescriptor: number;
  maximumErrorBytes: number;
  maximumInputBytes: number;
  maximumOutputBytes: number;
  profileIdentity: string;
  timeoutKillSignal: "SIGKILL";
  timeoutMilliseconds: number;
  workingDirectory: string;
}>;

type PinnedProcessProfileInput = Omit<PinnedProcessProfile, "executablePath" | "profileIdentity" | "timeoutKillSignal">;

export type PinnedProcessResult = Readonly<{
  argumentsIdentity: string;
  durationNanoseconds: string;
  environmentProjectionIdentity: string;
  executableIdentityHash: string;
  inputSha256: string;
  profileIdentity: string;
  signal: NodeJS.Signals | null;
  status: number | null;
  stderr: Buffer;
  stderrSha256: string;
  stdout: Buffer;
  stdoutSha256: string;
  terminationAccepted: boolean;
}>;

type ExecutableState = {
  active: boolean;
  descriptor: number;
  identity: BigIntStats;
};

type BindingState = {
  active: boolean;
  descriptor: number;
  identity: BigIntStats;
};

const EXECUTABLE_STATES = new WeakMap<PinnedProcessExecutable, ExecutableState>();
const BINDING_STATES = new WeakMap<PinnedProcessBinding, BindingState>();
const PROFILE_PROJECTION_KEYS = deepFreeze([
  "allowedSignals", "allowedStatuses", "bindingTargets", "environment", "executablePath",
  "executableTargetDescriptor", "maximumErrorBytes", "maximumInputBytes", "maximumOutputBytes",
  "timeoutKillSignal", "timeoutMilliseconds", "workingDirectory",
]);
const PROFILE_INPUT_KEYS = deepFreeze(PROFILE_PROJECTION_KEYS.filter((key) => key !== "executablePath" && key !== "timeoutKillSignal"));
const PROFILE_KEYS = deepFreeze([...PROFILE_PROJECTION_KEYS, "profileIdentity"].toSorted());

/**
 * The sole profile compiler. The executable path and identity are derived here
 * so callers cannot maintain a second copy of either authority preimage.
 */
export function compilePinnedProcessProfile(input: PinnedProcessProfileInput): PinnedProcessProfile {
  if (input === null || typeof input !== "object" || Array.isArray(input) ||
    !hasExactKeys(input, PROFILE_INPUT_KEYS)) {
    throw processError("pinned_process_profile_input_invalid", "profile");
  }
  const candidate = {
    ...input,
    timeoutKillSignal: ROOT_POLICY.runtimeLanguageArchitecture.pinnedProcessExecution.timeoutKillSignal,
    executablePath: `${ROOT_POLICY.verification.safeRepositoryRead.procFileDescriptorRoot}/${input.executableTargetDescriptor}`,
  };
  if (!validProfileProjectionShape(candidate)) {
    throw processError("pinned_process_profile_input_invalid", "profile");
  }
  const projection = pinnedProcessProfileProjection(candidate);
  validateProfileProjection(projection, "profile");
  return deepFreeze({
    ...projection,
    profileIdentity: pinnedProcessProfileIdentity(projection),
  });
}

export function withPinnedProcessExecutable<Result>(
  absolutePath: string,
  maximumBytes: number,
  mechanismTestOnly: boolean,
  operation: (executable: PinnedProcessExecutable) => Result,
): Result {
  const pinned = openPinnedAbsoluteFile(absolutePath, maximumBytes);
  const executable = deepFreeze({
    identityHash: pinnedPathIdentityHash(pinned.identity),
    mechanismTestOnly,
  });
  const state: ExecutableState = {
    active: true,
    descriptor: pinned.descriptor,
    identity: pinned.identity,
  };
  EXECUTABLE_STATES.set(executable, state);
  return settleScopedCapability(operation, executable, () => {
    state.active = false;
    closePinnedPathChain(pinned.chain);
  });
}

export function withBorrowedPinnedProcessBinding<Result>(
  descriptor: number,
  expectedIdentity: BigIntStats,
  operation: (binding: PinnedProcessBinding) => Result,
): Result {
  const observed = fstatSync(descriptor, { bigint: true });
  if (!sameStablePinnedPathIdentity(observed, expectedIdentity)) {
    throw processError("pinned_process_binding_identity_changed", String(descriptor));
  }
  const binding = deepFreeze({ identityHash: pinnedPathIdentityHash(observed) });
  const state: BindingState = { active: true, descriptor, identity: observed };
  BINDING_STATES.set(binding, state);
  return settleScopedCapability(operation, binding, () => { state.active = false; });
}

export function runPinnedProcess(
  profile: PinnedProcessProfile,
  executable: PinnedProcessExecutable,
  bindings: Readonly<Record<string, PinnedProcessBinding>>,
  arguments_: readonly string[],
  inputBytes: Uint8Array,
): PinnedProcessResult {
  validateProfile(profile);
  const executableState = requireExecutable(executable);
  const bindingStates = profile.bindingTargets.map((target) => ({
    ...target,
    state: requireBinding(bindings[target.id], target.id),
  }));
  if (Object.keys(bindings).toSorted().join("\0") !==
    profile.bindingTargets.map((target) => target.id).toSorted().join("\0")) {
    throw processError("pinned_process_binding_set_invalid", profile.profileIdentity);
  }
  if (arguments_.some((argument) => argument.includes("\0"))) {
    throw processError("pinned_process_arguments_invalid", profile.profileIdentity);
  }
  const input = Buffer.from(inputBytes);
  if (input.length > profile.maximumInputBytes) {
    throw processError("pinned_process_input_too_large", profile.profileIdentity);
  }
  recheckExecutable(executableState);
  for (const binding of bindingStates) recheckBinding(binding.state, binding.id);

  const highestDescriptor = Math.max(
    profile.executableTargetDescriptor,
    ...profile.bindingTargets.map((target) => target.targetDescriptor),
  );
  const stdio: (number | "ignore" | "pipe")[] = Array(highestDescriptor + 1).fill("ignore");
  stdio[0] = "pipe";
  stdio[1] = "pipe";
  stdio[2] = "pipe";
  stdio[profile.executableTargetDescriptor] = executableState.descriptor;
  for (const binding of bindingStates) stdio[binding.targetDescriptor] = binding.state.descriptor;

  const started = process.hrtime.bigint();
  const child = spawnSync(profile.executablePath, [...arguments_], {
    cwd: profile.workingDirectory,
    encoding: "buffer",
    env: { ...profile.environment },
    input,
    maxBuffer: Math.max(profile.maximumOutputBytes, profile.maximumErrorBytes),
    shell: false,
    stdio,
    timeout: profile.timeoutMilliseconds,
    killSignal: profile.timeoutKillSignal,
    windowsHide: true,
  });
  const durationNanoseconds = (process.hrtime.bigint() - started).toString(10);
  recheckExecutable(executableState);
  for (const binding of bindingStates) recheckBinding(binding.state, binding.id);
  if (child.error !== undefined) {
    const code = (child.error as NodeJS.ErrnoException).code;
    throw processError(code === "ETIMEDOUT" ? "pinned_process_timed_out"
      : code === "ENOBUFS" ? "pinned_process_output_too_large" : "pinned_process_launch_failed", profile.profileIdentity);
  }
  const stdout = Buffer.from(child.stdout ?? Buffer.alloc(0));
  const stderr = Buffer.from(child.stderr ?? Buffer.alloc(0));
  if (stdout.length > profile.maximumOutputBytes || stderr.length > profile.maximumErrorBytes) {
    throw processError("pinned_process_output_too_large", profile.profileIdentity);
  }
  const terminationAccepted = child.status !== null
    ? profile.allowedStatuses.includes(child.status)
    : child.signal !== null && profile.allowedSignals.includes(child.signal);
  return Object.freeze({
    argumentsIdentity: canonicalHash(arguments_),
    durationNanoseconds,
    environmentProjectionIdentity: canonicalHash(profile.environment),
    executableIdentityHash: executable.identityHash,
    inputSha256: sha256(input),
    profileIdentity: profile.profileIdentity,
    signal: child.signal,
    status: child.status,
    stderr,
    stderrSha256: sha256(stderr),
    stdout,
    stdoutSha256: sha256(stdout),
    terminationAccepted,
  });
}

function settleScopedCapability<Capability extends object, Result>(
  operation: (capability: Capability) => Result,
  capability: Capability,
  close: () => void,
): Result {
  let closed = false;
  const closeOnce = (): void => {
    if (closed) return;
    closed = true;
    close();
  };
  try {
    const result = operation(capability);
    if ((typeof result === "object" && result !== null || typeof result === "function") &&
      "then" in result && typeof (result as { then?: unknown }).then === "function") {
      return Promise.resolve(result).finally(closeOnce) as Result;
    }
    closeOnce();
    return result;
  } catch (error) {
    closeOnce();
    throw error;
  }
}

function requireExecutable(executable: PinnedProcessExecutable): ExecutableState {
  const state = EXECUTABLE_STATES.get(executable);
  if (state === undefined || !state.active) {
    throw processError("pinned_process_executable_capability_invalid", executable.identityHash);
  }
  return state;
}

function requireBinding(binding: PinnedProcessBinding | undefined, id: string): BindingState {
  const state = binding === undefined ? undefined : BINDING_STATES.get(binding);
  if (state === undefined || !state.active) {
    throw processError("pinned_process_binding_capability_invalid", id);
  }
  return state;
}

function recheckExecutable(state: ExecutableState): void {
  const observed = fstatSync(state.descriptor, { bigint: true });
  if (!samePinnedPathIdentity(observed, state.identity)) {
    throw processError("pinned_process_executable_identity_changed", String(state.descriptor));
  }
}

function recheckBinding(state: BindingState, id: string): void {
  const observed = fstatSync(state.descriptor, { bigint: true });
  if (!sameStablePinnedPathIdentity(observed, state.identity)) {
    throw processError("pinned_process_binding_identity_changed", id);
  }
}

function validateProfile(profile: PinnedProcessProfile): void {
  if (profile === null || typeof profile !== "object" || Array.isArray(profile) ||
    !hasExactKeys(profile, PROFILE_KEYS) || typeof profile.profileIdentity !== "string" ||
    !validProfileProjectionShape(profile)) {
    throw processError("pinned_process_profile_invalid", "profile");
  }
  const projection = pinnedProcessProfileProjection(profile);
  validateProfileProjection(projection, profile.profileIdentity);
  if (!SHA256_HEX_REGEX.test(profile.profileIdentity)) {
    throw processError("pinned_process_profile_invalid", profile.profileIdentity);
  }
  if (profile.profileIdentity !== pinnedProcessProfileIdentity(projection)) {
    throw processError("pinned_process_profile_identity_mismatch", profile.profileIdentity);
  }
}

function validateProfileProjection(
  profile: Omit<PinnedProcessProfile, "profileIdentity">,
  errorValue: string,
): void {
  const targetDescriptors = [
    profile.executableTargetDescriptor,
    ...profile.bindingTargets.map((target) => target.targetDescriptor),
  ];
  const validTargets = targetDescriptors.every((descriptor) => Number.isSafeInteger(descriptor) && descriptor >= 3) &&
    new Set(targetDescriptors).size === targetDescriptors.length;
  const validBounds = [
    profile.maximumErrorBytes, profile.maximumInputBytes, profile.maximumOutputBytes,
    profile.timeoutMilliseconds,
  ].every((value) => isPositiveFinite(value));
  const expectedExecutablePath = `${ROOT_POLICY.verification.safeRepositoryRead.procFileDescriptorRoot}/${profile.executableTargetDescriptor}`;
  if (!validTargets || !validBounds ||
    profile.timeoutKillSignal !== ROOT_POLICY.runtimeLanguageArchitecture.pinnedProcessExecution.timeoutKillSignal ||
    profile.executablePath !== expectedExecutablePath || !profile.workingDirectory.startsWith("/") ||
    profile.workingDirectory.includes("\0") || profile.bindingTargets.some((target) =>
      !/^[a-z][a-z0-9-]{0,63}$/u.test(target.id)
    ) || new Set(profile.bindingTargets.map((target) => target.id)).size !== profile.bindingTargets.length ||
    profile.allowedSignals.some((signal) => !/^SIG[A-Z0-9]+$/u.test(signal)) ||
    profile.allowedStatuses.some((status) => !Number.isSafeInteger(status)) ||
    Object.entries(profile.environment).some(([key, value]) =>
      !/^[A-Z][A-Z0-9_]*$/u.test(key) || value.includes("\0")
    )) {
    throw processError("pinned_process_profile_invalid", errorValue);
  }
}

function validProfileProjectionShape(
  profile: Omit<PinnedProcessProfile, "profileIdentity">,
): boolean {
  const candidate = profile as unknown as Record<string, unknown>;
  if (!Array.isArray(candidate.allowedSignals) ||
    candidate.allowedSignals.some((signal) => typeof signal !== "string") ||
    !Array.isArray(candidate.allowedStatuses) ||
    candidate.allowedStatuses.some((status) => typeof status !== "number") ||
    !Array.isArray(candidate.bindingTargets) || candidate.bindingTargets.some((target) =>
      target === null || typeof target !== "object" || Array.isArray(target) ||
      !hasExactKeys(target, ["id", "targetDescriptor"]) ||
      typeof (target as { id?: unknown }).id !== "string" ||
      typeof (target as { targetDescriptor?: unknown }).targetDescriptor !== "number"
    )) return false;
  const environment = candidate.environment;
  if (environment === null || typeof environment !== "object" || Array.isArray(environment) ||
    Object.getPrototypeOf(environment) !== Object.prototype && Object.getPrototypeOf(environment) !== null ||
    Object.values(environment).some((value) => typeof value !== "string")) return false;
  return typeof candidate.executablePath === "string" &&
    typeof candidate.executableTargetDescriptor === "number" &&
    typeof candidate.maximumErrorBytes === "number" &&
    typeof candidate.maximumInputBytes === "number" &&
    typeof candidate.maximumOutputBytes === "number" &&
    typeof candidate.timeoutKillSignal === "string" &&
    typeof candidate.timeoutMilliseconds === "number" &&
    typeof candidate.workingDirectory === "string";
}

function pinnedProcessProfileProjection(
  profile: Omit<PinnedProcessProfile, "profileIdentity">,
): Omit<PinnedProcessProfile, "profileIdentity"> {
  return deepFreeze({
    allowedSignals: [...profile.allowedSignals],
    allowedStatuses: [...profile.allowedStatuses],
    bindingTargets: profile.bindingTargets.map((target) => ({
      id: target.id,
      targetDescriptor: target.targetDescriptor,
    })),
    environment: { ...profile.environment },
    executablePath: profile.executablePath,
    executableTargetDescriptor: profile.executableTargetDescriptor,
    maximumErrorBytes: profile.maximumErrorBytes,
    maximumInputBytes: profile.maximumInputBytes,
    maximumOutputBytes: profile.maximumOutputBytes,
    timeoutKillSignal: profile.timeoutKillSignal,
    timeoutMilliseconds: profile.timeoutMilliseconds,
    workingDirectory: profile.workingDirectory,
  });
}

function pinnedProcessProfileIdentity(profile: Omit<PinnedProcessProfile, "profileIdentity">): string {
  return canonicalDomainHash(cryptoDomain("pinned-process-profile", 1), profile);
}

function hasExactKeys(value: object, expectedKeys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).toSorted()) === JSON.stringify(expectedKeys);
}

function processError(code: string, value: string): HarnessError {
  return new HarnessError("Pinned process operation failed", code, false, { valueSha256: sha256(value) });
}
