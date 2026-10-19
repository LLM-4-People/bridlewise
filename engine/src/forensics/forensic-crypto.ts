import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createSecretKey,
  KeyObject,
  timingSafeEqual,
} from "node:crypto";
import { types } from "node:util";

import { InputError, SecurityError } from "../kernel/errors.ts";
import {
  FORENSIC_LEDGER_VERIFICATION_ANCHOR_SCHEMA,
  FORENSIC_LEDGER_VERIFICATION_RECORD_SCHEMA,
  FORENSIC_SEQUENCE_SCHEMA,
  type ForensicLedgerVerificationAnchor,
  type ForensicLedgerVerificationRecord,
} from "./forensic-contracts.ts";
import { canonicalizeLedgerJson } from "../kernel/ledger-canonical.ts";
import { deepFreeze, isNonNegativeSafeInteger, sha256, SHA256_HEX_REGEX } from "../kernel/integrity.ts";
import { schemaId } from "../kernel/product-identity.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { FORENSIC_STRUCTURAL_SNAPSHOT_LIMITS } from "./forensic-structural.ts";
import {
  assertNotProxy,
  isProxyValue,
  snapshotJsonValue,
  snapshotPlainArray,
  snapshotPlainRecord,
} from "../kernel/safe-structural.ts";

declare const AEAD_PORT_BRAND: unique symbol;
declare const LEDGER_MAC_CAPABILITY_BRAND: unique symbol;
declare const BLIND_INDEX_CAPABILITY_BRAND: unique symbol;

export type AeadKeyOperations = Readonly<{
  readonly [AEAD_PORT_BRAND]: "opaque-aead-key-operations";
  seal: (nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array) => Readonly<{
    ciphertext: Buffer;
    authenticationTag: Buffer;
  }>;
  open: (nonce: Uint8Array, ciphertext: Uint8Array, authenticationTag: Uint8Array, aad: Uint8Array) => Buffer;
}>;

export type LedgerMacCapability = Readonly<{
  readonly [LEDGER_MAC_CAPABILITY_BRAND]: "opaque-ledger-mac-capability";
}>;

export type BlindIndexCapability = Readonly<{
  readonly [BLIND_INDEX_CAPABILITY_BRAND]: "opaque-blind-index-capability";
}>;

export type ForensicHmacCapabilities = Readonly<{
  ledgerMac: LedgerMacCapability;
  blindIndex: BlindIndexCapability;
}>;

export type SealedForensicPayload = Readonly<{
  schemaVersion: typeof SEALED_FORENSIC_PAYLOAD_SCHEMA_VERSION;
  algorithm: "AES-256-GCM";
  nonceBase64: string;
  authenticationTagBase64: string;
  ciphertextBase64: string;
  ciphertextBytes: number;
  ciphertextSha256: string;
  aadSha256: string;
}>;

export type SealedPayloadAadFields = Readonly<{
  ledgerId: string;
  eventId: string;
  sequence: string;
  classification: typeof ROOT_POLICY.forensics.classifications[number];
  purpose: "raw-event" | "raw-capture";
}>;

export type LedgerVerificationResult = Readonly<{
  valid: boolean;
  verifiedEntries: number;
  firstBadSequence?: string;
  code?: "anchor-invalid" | "records-invalid" | "record-invalid" | "capability-invalid" |
    "coordinate" | "sequence" | "previous-hash" | "entry-hash" | "previous-mac" | "entry-mac";
}>;

export const FORENSIC_CRYPTO_REVISION = "s3.1-forensic-crypto-capabilities/v2";

const SEALED_FORENSIC_PAYLOAD_SCHEMA_VERSION = schemaId("sealed-forensic-payload", 1);

const ISSUED_AEAD_PORTS = new WeakSet<object>();
type InternalMacOperations = Readonly<{
  mac: (message: Uint8Array) => Buffer;
  verify: (message: Uint8Array, expectedMac: Uint8Array) => boolean;
}>;
const ISSUED_LEDGER_MAC_CAPABILITIES = new WeakMap<object, InternalMacOperations>();
const ISSUED_BLIND_INDEX_CAPABILITIES = new WeakMap<object, InternalMacOperations>();
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export function createAes256GcmKeyOperations(secret: KeyObject): AeadKeyOperations {
  assertNotProxy(secret, "forensic_aead_secret_invalid");
  if (!(secret instanceof KeyObject) || !types.isKeyObject(secret) || secret.type !== "secret" ||
    secret.symmetricKeySize !== ROOT_POLICY.forensics.algorithms.keyBytes) {
    throw new InputError("AES-GCM requires an opaque 256-bit secret KeyObject", "forensic_aead_secret_invalid");
  }
  const operations = Object.freeze({
    seal: (nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array) => {
      const nonceCopy = exactBytes(nonce, ROOT_POLICY.forensics.algorithms.nonceBytes, "forensic_nonce_invalid");
      const plaintextCopy = boundedBytes(plaintext);
      const aadCopy = boundedBytes(aad);
      const cipher = createCipheriv("aes-256-gcm", secret, nonceCopy, {
        authTagLength: ROOT_POLICY.forensics.algorithms.authenticationTagBytes,
      });
      cipher.setAAD(aadCopy, { plaintextLength: plaintextCopy.byteLength });
      const ciphertext = Buffer.concat([cipher.update(plaintextCopy), cipher.final()]);
      const authenticationTag = cipher.getAuthTag();
      return Object.freeze({ ciphertext, authenticationTag });
    },
    open: (nonce: Uint8Array, ciphertext: Uint8Array, authenticationTag: Uint8Array, aad: Uint8Array) => {
      const nonceCopy = exactBytes(nonce, ROOT_POLICY.forensics.algorithms.nonceBytes, "forensic_nonce_invalid");
      const ciphertextCopy = boundedBytes(ciphertext);
      const tagCopy = exactBytes(
        authenticationTag,
        ROOT_POLICY.forensics.algorithms.authenticationTagBytes,
        "forensic_authentication_tag_invalid",
      );
      const aadCopy = boundedBytes(aad);
      try {
        const decipher = createDecipheriv("aes-256-gcm", secret, nonceCopy, {
          authTagLength: ROOT_POLICY.forensics.algorithms.authenticationTagBytes,
        });
        decipher.setAAD(aadCopy, { plaintextLength: ciphertextCopy.byteLength });
        decipher.setAuthTag(tagCopy);
        return Buffer.concat([decipher.update(ciphertextCopy), decipher.final()]);
      } catch {
        throw new SecurityError("Sealed forensic payload authentication failed", "forensic_aead_authentication_failed");
      }
    },
  });
  ISSUED_AEAD_PORTS.add(operations);
  return operations as unknown as AeadKeyOperations;
}

export function createForensicHmacCapabilities(secret: KeyObject): ForensicHmacCapabilities {
  assertNotProxy(secret, "forensic_hmac_secret_invalid");
  if (!(secret instanceof KeyObject) || !types.isKeyObject(secret) || secret.type !== "secret" ||
    (secret.symmetricKeySize ?? 0) < ROOT_POLICY.forensics.algorithms.digestBytes) {
    throw new InputError("HMAC requires an opaque secret KeyObject of at least 256 bits", "forensic_hmac_secret_invalid");
  }
  const ledgerSecret = createSecretKey(createHmac("sha256", secret)
    .update(ROOT_POLICY.forensics.domains.ledgerMacKeyDerivation, "utf8").digest());
  const blindSecret = createSecretKey(createHmac("sha256", secret)
    .update(ROOT_POLICY.forensics.domains.blindIndexKeyDerivation, "utf8").digest());
  const ledgerMac = Object.freeze({}) as LedgerMacCapability;
  const blindIndex = Object.freeze({}) as BlindIndexCapability;
  ISSUED_LEDGER_MAC_CAPABILITIES.set(ledgerMac, internalMacOperations(ledgerSecret));
  ISSUED_BLIND_INDEX_CAPABILITIES.set(blindIndex, internalMacOperations(blindSecret));
  return Object.freeze({ ledgerMac, blindIndex });
}

export function buildSealedPayloadAad(fields: SealedPayloadAadFields): Buffer {
  const safeFields = normalizeSealedPayloadAadFields(fields);
  return buildSealedPayloadAadFromSnapshot(safeFields);
}

function buildSealedPayloadAadFromSnapshot(fields: SealedPayloadAadFields): Buffer {
  return Buffer.concat([
    Buffer.from(ROOT_POLICY.forensics.domains.sealedPayload, "utf8"),
    canonicalizeLedgerJson(fields),
  ]);
}

export function sealForensicPayload(
  plaintext: Uint8Array,
  fields: SealedPayloadAadFields,
  nonce: Uint8Array,
  operations: AeadKeyOperations,
): SealedForensicPayload {
  assertAeadPort(operations);
  const plaintextCopy = boundedBytes(plaintext);
  const nonceCopy = exactBytes(nonce, ROOT_POLICY.forensics.algorithms.nonceBytes, "forensic_nonce_invalid");
  const safeFields = normalizeSealedPayloadAadFields(fields);
  const aad = buildSealedPayloadAadFromSnapshot(safeFields);
  const sealed = operations.seal(nonceCopy, plaintextCopy, aad);
  return deepFreeze({
    schemaVersion: SEALED_FORENSIC_PAYLOAD_SCHEMA_VERSION,
    algorithm: ROOT_POLICY.forensics.algorithms.encryption,
    nonceBase64: nonceCopy.toString("base64"),
    authenticationTagBase64: sealed.authenticationTag.toString("base64"),
    ciphertextBase64: sealed.ciphertext.toString("base64"),
    ciphertextBytes: sealed.ciphertext.byteLength,
    ciphertextSha256: sha256(sealed.ciphertext),
    aadSha256: sha256(aad),
  });
}

export function openForensicPayload(
  sealed: SealedForensicPayload,
  fields: SealedPayloadAadFields,
  operations: AeadKeyOperations,
): Buffer {
  assertAeadPort(operations);
  const safeSealed = snapshotPlainRecord(sealed, [
    "schemaVersion", "algorithm", "nonceBase64", "authenticationTagBase64", "ciphertextBase64",
    "ciphertextBytes", "ciphertextSha256", "aadSha256",
  ], FORENSIC_STRUCTURAL_SNAPSHOT_LIMITS, "forensic_sealed_metadata_invalid");
  if (safeSealed.schemaVersion !== SEALED_FORENSIC_PAYLOAD_SCHEMA_VERSION ||
    safeSealed.algorithm !== ROOT_POLICY.forensics.algorithms.encryption ||
    typeof safeSealed.nonceBase64 !== "string" || typeof safeSealed.authenticationTagBase64 !== "string" ||
    typeof safeSealed.ciphertextBase64 !== "string" || typeof safeSealed.ciphertextBytes !== "number" ||
    typeof safeSealed.ciphertextSha256 !== "string" || !SHA256_HEX_REGEX.test(safeSealed.ciphertextSha256) ||
    typeof safeSealed.aadSha256 !== "string" || !SHA256_HEX_REGEX.test(safeSealed.aadSha256) ||
    !isNonNegativeSafeInteger(safeSealed.ciphertextBytes)) {
    throw new InputError("Sealed forensic payload metadata is invalid", "forensic_sealed_metadata_invalid");
  }
  const nonce = decodeBase64Exact(safeSealed.nonceBase64, ROOT_POLICY.forensics.algorithms.nonceBytes);
  const tag = decodeBase64Exact(safeSealed.authenticationTagBase64, ROOT_POLICY.forensics.algorithms.authenticationTagBytes);
  const ciphertext = decodeBase64Exact(safeSealed.ciphertextBase64);
  if (ciphertext.byteLength !== safeSealed.ciphertextBytes ||
    !constantTimeHexEqual(sha256(ciphertext), safeSealed.ciphertextSha256)) {
    throw new SecurityError("Sealed forensic ciphertext digest failed", "forensic_ciphertext_digest_failed");
  }
  const safeFields = normalizeSealedPayloadAadFields(fields);
  const aad = buildSealedPayloadAadFromSnapshot(safeFields);
  if (!constantTimeHexEqual(sha256(aad), safeSealed.aadSha256)) {
    throw new SecurityError("Sealed forensic AAD digest failed", "forensic_aad_digest_failed");
  }
  const plaintext = operations.open(nonce, ciphertext, tag, aad);
  return plaintext;
}

export function computeLedgerEntryHash(previousEntryHash: string, envelope: unknown): string {
  const previous = decodeHex256(previousEntryHash, "forensic_previous_entry_hash_invalid");
  return sha256(Buffer.concat([
    Buffer.from(ROOT_POLICY.forensics.domains.ledgerEntry, "utf8"),
    previous,
    canonicalizeLedgerJson(envelope),
  ]));
}

export function computeLedgerEntryMac(
  ledgerId: string,
  segmentId: string,
  sequence: string,
  previousEntryMac: string,
  entryHash: string,
  capability: LedgerMacCapability,
): string {
  const operations = ledgerMacOperations(capability);
  const message = buildLedgerMacPreimage(ledgerId, segmentId, sequence, previousEntryMac, entryHash);
  return operations.mac(message).toString("hex");
}

export function verifyLedgerEntryMac(
  ledgerId: string,
  segmentId: string,
  sequence: string,
  previousEntryMac: string,
  entryHash: string,
  expectedMac: string,
  capability: LedgerMacCapability,
): boolean {
  try {
    const operations = ledgerMacOperations(capability);
    if (typeof expectedMac !== "string" || !SHA256_HEX_REGEX.test(expectedMac)) return false;
    return operations.verify(
      buildLedgerMacPreimage(ledgerId, segmentId, sequence, previousEntryMac, entryHash),
      Buffer.from(expectedMac, "hex"),
    );
  } catch {
    return false;
  }
}

export function verifyLedgerChain(
  recordsInput: unknown,
  anchorInput: unknown,
  capability: LedgerMacCapability,
): LedgerVerificationResult {
  let operations: InternalMacOperations;
  try {
    operations = ledgerMacOperations(capability);
  } catch {
    return invalidLedgerResult("capability-invalid", 0);
  }
  const anchor = parseLedgerAnchor(anchorInput);
  if (!anchor) return invalidLedgerResult("anchor-invalid", 0);
  const records = parseLedgerRecords(recordsInput);
  if (!records) return invalidLedgerResult("records-invalid", 0);
  let expectedSequence = BigInt(anchor.nextSequence);
  let previousHash = anchor.previousEntryHash;
  let previousMac = anchor.previousEntryMac;
  let verifiedEntries = 0;
  for (const record of records) {
    const bad = (code: NonNullable<LedgerVerificationResult["code"]>): LedgerVerificationResult =>
      invalidLedgerResult(code, verifiedEntries, record.sequence);
    if (record.ledgerId !== anchor.ledgerId || record.segmentId !== anchor.segmentId) return bad("coordinate");
    if (BigInt(record.sequence) !== expectedSequence) return bad("sequence");
    if (!constantTimeHexEqual(record.previousEntryHash, previousHash)) return bad("previous-hash");
    let computedHash: string;
    try {
      computedHash = computeLedgerEntryHash(record.previousEntryHash, record.envelope);
    } catch {
      return bad("entry-hash");
    }
    if (!constantTimeHexEqual(record.entryHash, computedHash)) return bad("entry-hash");
    if (!constantTimeHexEqual(record.previousEntryMac, previousMac)) return bad("previous-mac");
    if (!operations.verify(
      buildLedgerMacPreimage(
        record.ledgerId,
        record.segmentId,
        record.sequence,
        record.previousEntryMac,
        record.entryHash,
      ),
      Buffer.from(record.entryMac, "hex"),
    )) return bad("entry-mac");
    previousHash = record.entryHash;
    previousMac = record.entryMac;
    expectedSequence += 1n;
    verifiedEntries += 1;
  }
  return deepFreeze({ valid: true, verifiedEntries });
}

export function computeBlindIndex(
  purpose: "request-correlation" | "session-correlation" | "actor-correlation",
  value: string,
  capability: BlindIndexCapability,
): string {
  const operations = blindIndexOperations(capability);
  if (typeof value !== "string" ||
    (purpose !== "request-correlation" && purpose !== "session-correlation" && purpose !== "actor-correlation") ||
    Buffer.byteLength(value, "utf8") > ROOT_POLICY.forensics.limits.maximumInputBytes) {
    throw new InputError("Blind-index input is invalid", "forensic_blind_index_input_invalid");
  }
  return operations.mac(Buffer.concat([
    Buffer.from(ROOT_POLICY.forensics.domains.blindIndex, "utf8"),
    Buffer.from(purpose, "utf8"),
    Buffer.of(0),
    Buffer.from(value, "utf8"),
  ])).toString("hex");
}

export function buildLedgerMacPreimage(
  ledgerId: string,
  segmentId: string,
  sequence: string,
  previousEntryMac: string,
  entryHash: string,
): Buffer {
  if (typeof ledgerId !== "string" || typeof segmentId !== "string" || typeof sequence !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u.test(ledgerId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u.test(segmentId) ||
    !FORENSIC_SEQUENCE_SCHEMA.safeParse(sequence).success) {
    throw new InputError("Ledger MAC coordinates are invalid", "forensic_ledger_coordinates_invalid");
  }
  const ledgerBytes = Buffer.from(ledgerId, "utf8");
  const segmentBytes = Buffer.from(segmentId, "utf8");
  const sequenceBytes = Buffer.alloc(8);
  sequenceBytes.writeBigUInt64BE(BigInt(sequence));
  return Buffer.concat([
    Buffer.from(ROOT_POLICY.forensics.domains.ledgerMac, "utf8"),
    uint32be(ledgerBytes.byteLength),
    ledgerBytes,
    uint32be(segmentBytes.byteLength),
    segmentBytes,
    sequenceBytes,
    decodeHex256(previousEntryMac, "forensic_previous_entry_mac_invalid"),
    decodeHex256(entryHash, "forensic_entry_hash_invalid"),
  ]);
}

function assertAeadPort(operations: AeadKeyOperations): void {
  if (isProxyValue(operations) || typeof operations !== "object" || operations === null ||
    !ISSUED_AEAD_PORTS.has(operations)) {
    throw new SecurityError("Unissued AEAD operations port", "forensic_aead_port_invalid");
  }
}

function internalMacOperations(secret: KeyObject): InternalMacOperations {
  return Object.freeze({
    mac: (message: Uint8Array) => createHmac("sha256", secret).update(boundedBytes(message)).digest(),
    verify: (message: Uint8Array, expectedMac: Uint8Array) => {
      const expected = boundedBytes(expectedMac);
      if (expected.byteLength !== ROOT_POLICY.forensics.algorithms.digestBytes) return false;
      const actual = createHmac("sha256", secret).update(boundedBytes(message)).digest();
      return timingSafeEqual(actual, expected);
    },
  });
}

function ledgerMacOperations(capability: LedgerMacCapability): InternalMacOperations {
  if (isProxyValue(capability) || typeof capability !== "object" || capability === null) {
    throw new SecurityError("Ledger MAC capability is invalid", "forensic_hmac_port_invalid");
  }
  const operations = ISSUED_LEDGER_MAC_CAPABILITIES.get(capability);
  if (!operations) throw new SecurityError("Ledger MAC capability is invalid", "forensic_hmac_port_invalid");
  return operations;
}

function blindIndexOperations(capability: BlindIndexCapability): InternalMacOperations {
  if (isProxyValue(capability) || typeof capability !== "object" || capability === null) {
    throw new SecurityError("Blind-index capability is invalid", "forensic_hmac_port_invalid");
  }
  const operations = ISSUED_BLIND_INDEX_CAPABILITIES.get(capability);
  if (!operations) throw new SecurityError("Blind-index capability is invalid", "forensic_hmac_port_invalid");
  return operations;
}

/**
 * A KEY CHECK VALUE: whether two holders use the same secret, without
 * revealing it — an HMAC of a purpose name under a key DERIVED for key checks
 * (its own domain), never under the secret itself. A store records it once
 * and compares it at open, so a second key is refused before it seals or
 * reads anything (the timeline's seal key, a3-design H2).
 */
export function computeKeyCheckValue(secret: KeyObject, purpose: string): string {
  assertNotProxy(secret, "forensic_hmac_secret_invalid");
  if (!(secret instanceof KeyObject) || !types.isKeyObject(secret) || secret.type !== "secret" ||
    (secret.symmetricKeySize ?? 0) < ROOT_POLICY.forensics.algorithms.digestBytes || purpose.length === 0) {
    throw new InputError("A key check needs an opaque secret KeyObject of at least 256 bits and a purpose", "forensic_hmac_secret_invalid");
  }
  const derived = createHmac("sha256", secret).update(ROOT_POLICY.forensics.domains.keyCheckDerivation, "utf8").digest();
  return createHmac("sha256", derived).update(purpose, "utf8").digest("hex");
}

function parseLedgerAnchor(input: unknown): ForensicLedgerVerificationAnchor | undefined {
  try {
    const snapshot = snapshotJsonValue(input, FORENSIC_STRUCTURAL_SNAPSHOT_LIMITS, "forensic_anchor_invalid");
    const parsed = FORENSIC_LEDGER_VERIFICATION_ANCHOR_SCHEMA.safeParse(snapshot);
    return parsed.success ? deepFreeze(parsed.data) as ForensicLedgerVerificationAnchor : undefined;
  } catch {
    return undefined;
  }
}

function parseLedgerRecords(input: unknown): readonly ForensicLedgerVerificationRecord[] | undefined {
  try {
    const snapshot = snapshotPlainArray(input, FORENSIC_STRUCTURAL_SNAPSHOT_LIMITS, "forensic_records_invalid");
    const records: ForensicLedgerVerificationRecord[] = [];
    for (const entry of snapshot) {
      const parsed = FORENSIC_LEDGER_VERIFICATION_RECORD_SCHEMA.safeParse(entry);
      if (!parsed.success) return undefined;
      try {
        canonicalizeLedgerJson(parsed.data.envelope);
      } catch {
        return undefined;
      }
      records.push(deepFreeze(parsed.data) as ForensicLedgerVerificationRecord);
    }
    return Object.freeze(records);
  } catch {
    return undefined;
  }
}

function invalidLedgerResult(
  code: NonNullable<LedgerVerificationResult["code"]>,
  verifiedEntries: number,
  firstBadSequence?: string,
): LedgerVerificationResult {
  return deepFreeze({
    valid: false,
    verifiedEntries,
    ...(firstBadSequence === undefined ? {} : { firstBadSequence }),
    code,
  });
}


function uint32be(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new InputError("Length prefix is invalid", "forensic_ledger_coordinates_invalid");
  }
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function boundedBytes(bytes: Uint8Array): Buffer {
  assertNotProxy(bytes, "forensic_crypto_input_invalid");
  if (!(bytes instanceof Uint8Array) || !types.isUint8Array(bytes) ||
    (Buffer.isBuffer(bytes)
      ? Object.getPrototypeOf(bytes) !== Buffer.prototype
      : Object.getPrototypeOf(bytes) !== Uint8Array.prototype) ||
    bytes.byteLength > ROOT_POLICY.forensics.limits.maximumInputBytes) {
    throw new InputError("Forensic cryptographic input is invalid", "forensic_crypto_input_invalid");
  }
  return Buffer.from(bytes);
}

function exactBytes(bytes: Uint8Array, expectedLength: number, code: string): Buffer {
  const result = boundedBytes(bytes);
  if (result.byteLength !== expectedLength) throw new InputError("Cryptographic value length is invalid", code);
  return result;
}

function decodeHex256(value: string, code: string): Buffer {
  if (typeof value !== "string" || !SHA256_HEX_REGEX.test(value)) throw new InputError("SHA-256 value is invalid", code);
  return Buffer.from(value, "hex");
}

function decodeBase64Exact(value: string, expectedLength?: number): Buffer {
  if (typeof value !== "string" || !BASE64.test(value)) {
    throw new InputError("Base64 value is invalid", "forensic_base64_invalid");
  }
  const result = Buffer.from(value, "base64");
  if (result.toString("base64") !== value || (expectedLength !== undefined && result.byteLength !== expectedLength) ||
    result.byteLength > ROOT_POLICY.forensics.limits.maximumInputBytes) {
    throw new InputError("Base64 value is non-canonical or has the wrong length", "forensic_base64_invalid");
  }
  return result;
}

function constantTimeHexEqual(left: unknown, right: unknown): boolean {
  if (typeof left !== "string" || typeof right !== "string" || !SHA256_HEX_REGEX.test(left) || !SHA256_HEX_REGEX.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function normalizeSealedPayloadAadFields(fields: SealedPayloadAadFields): SealedPayloadAadFields {
  const value = snapshotPlainRecord(
    fields,
    ["ledgerId", "eventId", "sequence", "classification", "purpose"],
    FORENSIC_STRUCTURAL_SNAPSHOT_LIMITS,
    "forensic_aad_fields_invalid",
    {
      objectPrototype: "forensic_crypto_object_invalid",
      arrayPrototype: "forensic_crypto_object_invalid",
    },
  );
  if (typeof value.ledgerId !== "string" || typeof value.eventId !== "string" ||
    typeof value.sequence !== "string" || typeof value.classification !== "string" ||
    typeof value.purpose !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u.test(value.ledgerId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u.test(value.eventId) ||
    !FORENSIC_SEQUENCE_SCHEMA.safeParse(value.sequence).success ||
    !ROOT_POLICY.forensics.classifications.includes(value.classification as never) ||
    (value.purpose !== "raw-event" && value.purpose !== "raw-capture")) {
    throw new InputError("Sealed forensic AAD fields are invalid", "forensic_aad_fields_invalid");
  }
  return Object.freeze({
    ledgerId: value.ledgerId,
    eventId: value.eventId,
    sequence: value.sequence,
    classification: value.classification as SealedPayloadAadFields["classification"],
    purpose: value.purpose,
  });
}
