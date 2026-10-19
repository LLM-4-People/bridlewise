import { InputError } from "../../../kernel/errors.ts";
import { canonicalDomainHash, deepFreeze } from "../../../kernel/integrity.ts";
import { relativePathViolationKinds } from "../../../filesystem/path-boundary.ts";
import { assertNotProxy } from "../../../kernel/safe-structural.ts";
import { schemaId } from "../../../kernel/product-identity.ts";

export const EXACT_WRITE_LEASE_SCHEMA_VERSION = schemaId("exact-write-lease", 1);
export const EXACT_WRITE_LEASE_PATH_ENCODING =
  "nfc-repository-relative-forward-slash-closed-logical-subset" as const;
export const EXACT_WRITE_LEASE_AUTHORITY_STAGE = "pre-effect-plan-validation-only" as const;
export const EXACT_WRITE_LEASE_OPERATIONS = deepFreeze([
  "create-directory",
  "publish-file",
  "remove-path",
  "replace-file",
  "write-file",
] as const);

export type ExactWriteOperation = typeof EXACT_WRITE_LEASE_OPERATIONS[number];

export type ExactWriteEffect = Readonly<{
  operation: ExactWriteOperation;
  relativePath: string;
}>;

export type TransientWriteRootCapability = Readonly<{
  authorityStage: typeof EXACT_WRITE_LEASE_AUTHORITY_STAGE;
  scopeReference: "opaque-transient-root";
  serializable: false;
  toJSON: () => never;
}>;

export type ExactWriteLease = Readonly<{
  schemaVersion: typeof EXACT_WRITE_LEASE_SCHEMA_VERSION;
  authorityStage: typeof EXACT_WRITE_LEASE_AUTHORITY_STAGE;
  pathEncoding: typeof EXACT_WRITE_LEASE_PATH_ENCODING;
  serializable: false;
  effects: readonly ExactWriteEffect[];
  writeSetIdentity: string;
  toJSON: () => never;
}>;

const OPERATIONS = new Set<ExactWriteOperation>(EXACT_WRITE_LEASE_OPERATIONS);
const ROOT_TOKENS = new WeakMap<TransientWriteRootCapability, object>();
const LEASE_ROOTS = new WeakMap<ExactWriteLease, TransientWriteRootCapability>();

export function bindTransientWriteRootCapability(observationToken: object): TransientWriteRootCapability {
  assertNotProxy(observationToken, "effect_write_root_observation_invalid");
  const capability = nonserializableRecord({
    authorityStage: EXACT_WRITE_LEASE_AUTHORITY_STAGE,
    scopeReference: "opaque-transient-root" as const,
    serializable: false as const,
  });
  ROOT_TOKENS.set(capability, observationToken);
  return capability;
}

export function compileExactWriteLease(
  root: TransientWriteRootCapability,
  effects: readonly ExactWriteEffect[],
): ExactWriteLease {
  assertRootCapability(root);
  if (effects.length === 0) {
    throw new InputError("Exact write set is empty", "effect_write_set_empty");
  }
  const canonicalEffects = effects.map((effect) => {
    assertOperation(effect.operation);
    assertClosedLogicalTarget(effect.relativePath);
    return { operation: effect.operation, relativePath: effect.relativePath };
  }).toSorted(compareEffects);
  const effectKeys = canonicalEffects.map(effectKey);
  if (new Set(effectKeys).size !== effectKeys.length) {
    throw new InputError("Exact write set contains a duplicate", "effect_write_set_duplicate");
  }
  const writeSetIdentity = canonicalDomainHash("effect-boundary.write-set/v1", canonicalEffects);
  const lease = nonserializableRecord({
    schemaVersion: EXACT_WRITE_LEASE_SCHEMA_VERSION,
    authorityStage: EXACT_WRITE_LEASE_AUTHORITY_STAGE,
    pathEncoding: EXACT_WRITE_LEASE_PATH_ENCODING,
    serializable: false as const,
    effects: canonicalEffects,
    writeSetIdentity,
  });
  LEASE_ROOTS.set(lease, root);
  return lease;
}

export function assertExactWriteAuthorized(
  lease: ExactWriteLease,
  observedRoot: TransientWriteRootCapability,
  effect: ExactWriteEffect,
): void {
  assertRootCapability(observedRoot);
  const registeredRoot = LEASE_ROOTS.get(lease);
  if (registeredRoot === undefined || registeredRoot !== observedRoot ||
    lease.schemaVersion !== EXACT_WRITE_LEASE_SCHEMA_VERSION ||
    lease.authorityStage !== EXACT_WRITE_LEASE_AUTHORITY_STAGE ||
    lease.pathEncoding !== EXACT_WRITE_LEASE_PATH_ENCODING || lease.serializable !== false ||
    canonicalDomainHash("effect-boundary.write-set/v1", lease.effects) !== lease.writeSetIdentity) {
    throw new InputError("Exact write lease identity is invalid", "effect_write_lease_invalid");
  }
  assertOperation(effect.operation);
  assertClosedLogicalTarget(effect.relativePath);
  if (!lease.effects.some((candidate) => effectKey(candidate) === effectKey(effect))) {
    throw new InputError("Write target is outside the exact lease", "effect_write_target_unleased");
  }
}

function assertRootCapability(root: TransientWriteRootCapability): void {
  if (ROOT_TOKENS.get(root) === undefined || root.authorityStage !== EXACT_WRITE_LEASE_AUTHORITY_STAGE ||
    root.scopeReference !== "opaque-transient-root" || root.serializable !== false) {
    throw new InputError("Write root capability is invalid", "effect_write_root_capability_invalid");
  }
}

function assertOperation(operation: ExactWriteOperation): void {
  if (!OPERATIONS.has(operation)) {
    throw new InputError("Write operation is invalid", "effect_write_operation_invalid");
  }
}

function assertClosedLogicalTarget(relativePath: string): void {
  if (relativePath.normalize("NFC") !== relativePath || relativePathViolationKinds(relativePath).length > 0) {
    throw new InputError("Write target is not canonical", "effect_write_target_noncanonical");
  }
}

function compareEffects(left: ExactWriteEffect, right: ExactWriteEffect): number {
  if (left.relativePath < right.relativePath) return -1;
  if (left.relativePath > right.relativePath) return 1;
  if (left.operation < right.operation) return -1;
  if (left.operation > right.operation) return 1;
  return 0;
}

function effectKey(effect: ExactWriteEffect): string {
  return `${effect.operation}:${effect.relativePath}`;
}

function nonserializableRecord<Fields extends Readonly<Record<string, unknown>>>(
  fields: Fields,
): Readonly<Fields & { toJSON: () => never }> {
  const value = { ...fields } as Fields & { toJSON: () => never };
  Object.defineProperty(value, "toJSON", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: (): never => {
      throw new InputError("Transient write authority is not serializable", "effect_write_serialization_denied");
    },
  });
  return Object.freeze(value);
}
