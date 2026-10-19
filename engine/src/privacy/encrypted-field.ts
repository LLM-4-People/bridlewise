/** THE field codec: enc: + base64(nonce | tag | ciphertext), AES-256-GCM.
 * A prefix is only syntax; successful AEAD finalization admits opaque bytes.
 *
 * EVERY CALL NAMES WHAT THE CIPHERTEXT IS BOUND TO (`aad`, the associated
 * data; cred-audit CRED-F13). A value copied into another row, column, table
 * or owner — or a row reassigned to another owner by a database edit — then
 * fails authentication instead of decrypting where it was put. The ENCODING
 * of a binding is this codec's ({@link fieldAad}, over a closed domain
 * registry); which parts a value is bound to is its store's (the web
 * database: `server/db/db-crypto.ts`; memory: `server/context/memory-bridge.ts`;
 * the vault and settings later) — this codec only refuses to guess. `UNBOUND_FIELD` is the empty binding, for exactly the
 * ciphertext whose integrity comes from elsewhere or that predates binding
 * (see its doc). */
import { createCipheriv, createDecipheriv, KeyObject } from "node:crypto";
import { SecurityError } from "../kernel/errors.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { canonicalJson, randomBytes } from "../kernel/integrity.ts";

export const ENCRYPTED_FIELD_PREFIX = "enc:";
export const ENCRYPTED_FIELD_IV_BYTES = ROOT_POLICY.forensics.algorithms.nonceBytes;
export const ENCRYPTED_FIELD_TAG_BYTES = ROOT_POLICY.forensics.algorithms.authenticationTagBytes;
const KEY_BYTES = ROOT_POLICY.forensics.algorithms.keyBytes;

/**
 * The empty binding (GCM with empty associated data is byte-identical to none,
 * so every ciphertext written before binding existed authenticates under it).
 * Legitimate for exactly two populations: memory content written into the
 * append-only timeline before memory entries were sealed to their owner (a
 * ledger document cannot be re-encrypted, so those entries stay readable only
 * unbound; new entries are owner-bound, `ownerSealAad`), and the pre-binding
 * database fields that migrations read and rewrite.
 */
export const UNBOUND_FIELD = "";

/**
 * THE CLOSED REGISTRY OF BINDING DOMAINS — one per store that seals with this
 * codec, so a value of one store can never authenticate as another's:
 * database fields, memory entries, the credential vault, stored settings. A
 * new store adds its domain here (and a version bump is a new domain).
 */
export const FIELD_AAD_DOMAINS = ["bw-field-v1", "bw-memory-v1", "bw-secret-v1", "bw-setting-v1"] as const;
export type FieldAadDomain = typeof FIELD_AAD_DOMAINS[number];

/** Where a ledger document names the seal its content is bound to (with its owner, `metadata.userId`). */
export const OWNER_SEAL_METADATA_KEY = "sealId";

/**
 * THE OWNER SEAL of a ledger document's content: a document (a memory entry)
 * whose `metadata` carries its owning `userId` and the `sealId` minted with
 * it holds content bound to both (`bw-memory-v1`), so an edit that retargets
 * the entry to another user leaves the content unreadable. One recipe for the
 * writer (the memory bridge) and for the ledger's operational projection,
 * which keeps authenticated ciphertext intact (it must stay readable after a
 * restart). Undefined for a document without one.
 */
export function ownerSealAad(document: unknown): string | undefined {
  if (typeof document !== "object" || document === null) return undefined;
  const metadata = (document as { metadata?: unknown }).metadata;
  if (typeof metadata !== "object" || metadata === null) return undefined;
  const { userId, [OWNER_SEAL_METADATA_KEY]: sealId } = metadata as Record<string, unknown>;
  return typeof userId === "string" && userId.length > 0 && typeof sealId === "string" && sealId.length > 0
    ? fieldAad("bw-memory-v1", [userId, sealId]) : undefined;
}

/**
 * THE ONE ENCODING of associated data: the canonical JSON of the domain and
 * the parts, in order (`["bw-field-v1","messages","content",<id>,…]`).
 * Every store builds its binding here (secc-design M7), so no two stores
 * spell a binding two ways.
 */
export function fieldAad(domain: FieldAadDomain, parts: readonly (string | null)[]): string {
  if (!(FIELD_AAD_DOMAINS as readonly string[]).includes(domain)) {
    throw new SecurityError("Encrypted field binding domain is not registered", "encrypted_field_domain_unknown");
  }
  return canonicalJson([domain, ...parts]);
}

export function createEncryptedFieldCodec(key: KeyObject) {
  if (!(key instanceof KeyObject) || key.type !== "secret" || key.symmetricKeySize !== KEY_BYTES) {
    throw new SecurityError("Encrypted field key could not be admitted", "encrypted_field_key_invalid");
  }
  function decode(ciphertext: string, aad: string): Buffer {
    if (typeof ciphertext !== "string" || !ciphertext.startsWith(ENCRYPTED_FIELD_PREFIX)) {
      throw new SecurityError("Encrypted field could not be authenticated", "encrypted_field_invalid");
    }
    const encoded = ciphertext.slice(ENCRYPTED_FIELD_PREFIX.length), packed = Buffer.from(encoded, "base64");
    if (packed.length < ENCRYPTED_FIELD_IV_BYTES + ENCRYPTED_FIELD_TAG_BYTES || packed.toString("base64") !== encoded) {
      throw new SecurityError("Encrypted field could not be authenticated", "encrypted_field_invalid");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, packed.subarray(0, ENCRYPTED_FIELD_IV_BYTES), { authTagLength: ENCRYPTED_FIELD_TAG_BYTES });
    decipher.setAuthTag(packed.subarray(ENCRYPTED_FIELD_IV_BYTES, ENCRYPTED_FIELD_IV_BYTES + ENCRYPTED_FIELD_TAG_BYTES));
    if (aad.length > 0) decipher.setAAD(Buffer.from(aad, "utf8"));
    const pending = decipher.update(packed.subarray(ENCRYPTED_FIELD_IV_BYTES + ENCRYPTED_FIELD_TAG_BYTES));
    try { return Buffer.concat([pending, decipher.final()]); } finally { pending.fill(0); }
  }
  return Object.freeze({
    encrypt(plaintext: string, aad: string): string {
      if (typeof aad !== "string") throw new SecurityError("Encrypted field binding is missing", "encrypted_field_binding_missing");
      const nonce = randomBytes(ENCRYPTED_FIELD_IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: ENCRYPTED_FIELD_TAG_BYTES });
      if (aad.length > 0) cipher.setAAD(Buffer.from(aad, "utf8"));
      const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return ENCRYPTED_FIELD_PREFIX + Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64");
    },
    decrypt(ciphertext: string, aad: string): string {
      let bytes: Buffer | undefined;
      try { bytes = decode(ciphertext, aad); return bytes.toString("utf8"); }
      catch { throw new SecurityError("Encrypted field could not be authenticated", "encrypted_field_invalid"); }
      finally { bytes?.fill(0); }
    },
    authenticates(ciphertext: string, aad: string): boolean {
      let bytes: Buffer | undefined;
      try { bytes = decode(ciphertext, aad); return true; } catch { return false; }
      finally { bytes?.fill(0); }
    },
  });
}

/** Candidate discovery is not admission. Every returned interval passed AEAD
 * authentication with this held key under `aad`; no plaintext leaves this
 * operation. (The timeline projection asks for the ledger-carried population,
 * `UNBOUND_FIELD`; a row-bound field it cannot authenticate gets no exemption.) */
export function authenticatedEncryptedFieldRanges(text: string, key: KeyObject, aad: string): readonly Readonly<{ startUtf16: number; endUtf16: number }>[] {
  const codec = createEncryptedFieldCodec(key), ranges: { startUtf16: number; endUtf16: number }[] = [];
  for (const match of text.matchAll(/enc:[A-Za-z0-9+/]+=*/gu)) {
    if (codec.authenticates(match[0], aad)) ranges.push({ startUtf16: match.index, endUtf16: match.index + match[0].length });
  }
  return ranges;
}
