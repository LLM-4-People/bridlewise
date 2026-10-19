import { canonicalJson, deepFreeze, sha256, type CanonicalValue } from "../kernel/integrity.ts";
import {
  classificationRank,
  DATA_CLASSIFICATION,
  type DataClassification,
} from "./classification-catalog.ts";
import { ROOT_POLICY_HASH } from "../kernel/root-policy.ts";
import { isSensitiveKeyName, secretTextSignalIds } from "./secret-signals.ts";
import { bestEffort } from "../shared/best-effort.ts";

export type { DataClassification } from "./classification-catalog.ts";

export type ClassificationDecision = Readonly<{
  decision: "classified";
  code: "classification_complete";
  classification: DataClassification;
  payloadHash: string;
  signalCategories: readonly string[];
}>;

export type EgressDecision = Readonly<{
  decision: "deny";
  code: "egress_disabled_by_root_policy";
  destinationHash: string;
  classification: DataClassification;
  payloadHash: string;
  policyHash: string;
}>;

export function classifyData(
  payload: unknown,
  declared: Exclude<DataClassification, typeof DATA_CLASSIFICATION.credentialSecret>,
): ClassificationDecision {
  const signals = new Set<string>();
  let observed: DataClassification = declared;
  const seen = new Set<object>();

  const visit = (value: unknown, key?: string): void => {
    // Percent-decoding is THIS surface's duty (it is the one that sees encoded
    // keys); everything after the decode is the owner's. `isSensitiveKeyName`
    // holds BOTH halves of the key question — normalized parts AND the
    // separator-bounded SENSITIVE_KEY_PATTERNS — so consulting anything
    // narrower here reopens the gap where `SK_TEST` egressed as `public`
    // while every other consumer of the owner refused it (U-42). The raw
    // spelling is asked too, so a key that only reads sensitive before
    // decoding cannot slip through the decode.
    const decodedKey = key === undefined ? "" : safePercentDecode(key);
    if (
      (decodedKey && isSensitiveKeyName(decodedKey)) ||
      (key !== undefined && key !== decodedKey && isSensitiveKeyName(key))
    ) {
      observed = higher(observed, DATA_CLASSIFICATION.credentialSecret);
      signals.add("sensitive-key");
    }
    if (typeof value === "string") {
      for (const representation of stringRepresentations(value)) {
        if (secretTextSignalIds(representation, "classification").length > 0) {
          observed = higher(observed, DATA_CLASSIFICATION.credentialSecret);
          signals.add("secret-value-shape");
        }
      }
      return;
    }
    if (value === null || typeof value === "boolean" || typeof value === "number") return;
    if (typeof value !== "object") {
      observed = higher(observed, DATA_CLASSIFICATION.regulatedRestricted);
      signals.add("unsupported-value");
      return;
    }
    if (seen.has(value)) {
      observed = higher(observed, DATA_CLASSIFICATION.regulatedRestricted);
      signals.add("cyclic-value");
      return;
    }
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) {
      observed = higher(observed, DATA_CLASSIFICATION.regulatedRestricted);
      signals.add("unsupported-object");
    }
    if (Reflect.ownKeys(value).some((entry) => typeof entry === "symbol")) {
      observed = higher(observed, DATA_CLASSIFICATION.regulatedRestricted);
      signals.add("unsupported-key");
    }
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        const joined = value.every((entry) => typeof entry === "string") ? value.join("") : undefined;
        if (joined !== undefined) visit(joined, key);
        for (const entry of value) visit(entry, key);
      } else {
        for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
      }
    } finally {
      seen.delete(value);
    }
  };

  visit(payload);
  const normalized = normalizeForHash(payload, new Set<object>());
  return deepFreeze({
    decision: "classified",
    code: "classification_complete",
    classification: observed,
    payloadHash: sha256(canonicalJson(normalized)),
    signalCategories: [...signals].toSorted(),
  });
}

export function decideEgress(destination: string, classification: ClassificationDecision): EgressDecision {
  return deepFreeze({
    decision: "deny",
    code: "egress_disabled_by_root_policy",
    destinationHash: sha256(destination),
    classification: classification.classification,
    payloadHash: classification.payloadHash,
    policyHash: ROOT_POLICY_HASH,
  });
}

export function mostRestrictiveClassification(
  left: Exclude<DataClassification, typeof DATA_CLASSIFICATION.credentialSecret>,
  right: Exclude<DataClassification, typeof DATA_CLASSIFICATION.credentialSecret>,
): Exclude<DataClassification, typeof DATA_CLASSIFICATION.credentialSecret> {
  return classificationRank(right) > classificationRank(left) ? right : left;
}

function higher(left: DataClassification, right: DataClassification): DataClassification {
  return classificationRank(right) > classificationRank(left) ? right : left;
}

function stringRepresentations(value: string): readonly string[] {
  const representations = new Set([value, safePercentDecode(value)]);
  const compact = value.replace(/\s/gu, "");
  if (compact.length >= 16 && compact.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/u.test(compact)) {
    const decoded = bestEffort(() => Buffer.from(compact, "base64").toString("utf8"));
    if (decoded !== undefined && !decoded.includes("\uFFFD")) representations.add(decoded);
  }
  return [...representations];
}

/**
 * Percent-decode LENIENTLY — THE one percent decoder of the privacy domain:
 * every run of `%XX` escapes that is valid UTF-8 is decoded, and everything
 * else (a `%` not followed by two hex digits, a run that is not UTF-8) is
 * kept as written — the WHATWG percent-decode, never all-or-nothing. It used
 * to return the whole string undecoded when ANY escape was invalid, so
 * `a%40b%ZZ` never produced the `a@b%ZZ` a text carries (a2-correctness §2).
 * Never throws: an undecodable escape is a normal outcome, not a failure.
 */
export function safePercentDecode(value: string): string {
  if (!value.includes("%")) return value;
  return value.replace(/(?:%[0-9A-Fa-f]{2})+/gu, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

function normalizeForHash(value: unknown, ancestors: Set<object>): CanonicalValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value !== "object") return `[${typeof value}]`;
  if (ancestors.has(value)) return "[cyclic]";
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => normalizeForHash(entry, ancestors));
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, normalizeForHash(child, ancestors)]),
    );
  } finally {
    ancestors.delete(value);
  }
}
