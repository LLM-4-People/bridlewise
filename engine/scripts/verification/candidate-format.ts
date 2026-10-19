import { extname } from "node:path";
import { TextDecoder } from "node:util";

import { HarnessError } from "../../src/kernel/errors.ts";
import { canonicalHash, canonicalJson, deepFreeze, sha256 } from "../../src/kernel/integrity.ts";
import { relativePathViolationKinds } from "../../src/filesystem/path-boundary.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";

export type CandidateTextViolationKind =
  | "byte-order-mark"
  | "carriage-return"
  | "excess-final-newline"
  | "invalid-utf8"
  | "missing-final-newline"
  | "nul"
  | "trailing-whitespace";

export type ImmutableTextSourceException = Readonly<{
  path: string;
  sha256: string;
  authorityPath: string;
  authoritySha256: string;
  role: "exact-committed-official-source-fragment-manifest";
}>;

export type CandidateFormatOutcome = Readonly<{
  classification: "binary-exempt" | "canonical-text" | "immutable-source-text-exempt";
  violations: readonly string[];
  exception?: ImmutableTextSourceException;
}>;

type TextFinding = Readonly<{
  kind: CandidateTextViolationKind;
  line?: number;
}>;

const POLICY = ROOT_POLICY.verification.candidateFormat;
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function createCandidateFormatError(violations: readonly string[]): HarnessError {
  const ordered = deepFreeze([...new Set(violations)].toSorted());
  return new HarnessError("Candidate format rejected", "candidate_format_rejected", false, {
    violations: canonicalJson(ordered),
  });
}

export function candidateFormatErrorViolations(error: unknown): readonly string[] | undefined {
  if (!(error instanceof HarnessError) || error.code !== "candidate_format_rejected" ||
    typeof error.safeDetails.violations !== "string") return undefined;
  try {
    const parsed = JSON.parse(error.safeDetails.violations) as unknown;
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) return undefined;
    return deepFreeze([...new Set(parsed)].toSorted());
  } catch {
    return undefined;
  }
}

export function strictUtf8Text(bytes: Uint8Array): string {
  return STRICT_UTF8.decode(bytes);
}

export function candidatePathViolations(path: string): readonly string[] {
  return deepFreeze(relativePathViolationKinds(path).map((reason) =>
    `candidate-path-invalid:${reason}:${safePathLabel(path)}`
  ).toSorted());
}

export function candidatePathRejectedWithoutContentRead(path: string): boolean {
  const segments = path.toLowerCase().split("/");
  const basename = segments.at(-1) ?? "";
  const policy = POLICY.rejectedWithoutContentRead;
  const basenames = new Set<string>(policy.basenames);
  const pathSegments = new Set<string>(policy.pathSegments);
  return basenames.has(basename) ||
    policy.basenamePrefixes.some((prefix) => basename.startsWith(prefix)) ||
    policy.suffixes.some((suffix) => basename.endsWith(suffix)) ||
    segments.some((segment) => pathSegments.has(segment));
}

export function rejectedCandidatePathViolation(path: string): string {
  return `candidate-sensitive-path-rejected-without-read:${safePathLabel(path)}`;
}

export function candidateFormatForBytes(
  path: string,
  bytes: Uint8Array,
  immutableSource: ImmutableTextSourceException | undefined,
): CandidateFormatOutcome {
  const binary = POLICY.binary.formats.find((format) => extname(path).toLowerCase() === format.extension);
  if (binary !== undefined) {
    const prefix = Buffer.from(binary.magicHex, "hex");
    if (bytes.length < prefix.length || !Buffer.from(bytes.subarray(0, prefix.length)).equals(prefix)) {
      return deepFreeze({
        classification: "binary-exempt",
        violations: [`candidate-binary-signature-invalid:${safePathLabel(path)}`],
      });
    }
    return deepFreeze({ classification: "binary-exempt", violations: [] });
  }

  const findings = canonicalTextFindings(bytes);
  if (findings.length === 0) return deepFreeze({ classification: "canonical-text", violations: [] });
  const allowedExceptionKinds = new Set<string>(POLICY.immutableTextSourceExceptions.allowedViolationKinds);
  if (immutableSource !== undefined && immutableSource.path === path && immutableSource.sha256 === sha256(bytes) &&
    findings.every((finding) => allowedExceptionKinds.has(finding.kind))) {
    return deepFreeze({
      classification: "immutable-source-text-exempt",
      violations: [],
      exception: immutableSource,
    });
  }
  return deepFreeze({
    classification: "canonical-text",
    violations: findings.map((finding) => formatTextFinding(path, finding)),
  });
}

export function candidateFormatPolicyHash(): string {
  return canonicalHash(POLICY);
}

function canonicalTextFindings(bytes: Uint8Array): readonly TextFinding[] {
  const findings: TextFinding[] = [];
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    findings.push({ kind: "byte-order-mark" });
  }
  if (bytes.includes(0)) findings.push({ kind: "nul" });
  if (bytes.includes(0x0d)) findings.push({ kind: "carriage-return" });
  let text: string;
  try {
    text = strictUtf8Text(bytes);
  } catch {
    findings.push({ kind: "invalid-utf8" });
    return deepFreeze(findings);
  }
  if (bytes.length > 0) {
    if (bytes.at(-1) !== 0x0a) findings.push({ kind: "missing-final-newline" });
    else if (bytes.length >= 2 && bytes.at(-2) === 0x0a) findings.push({ kind: "excess-final-newline" });
  }
  const lines = text.split("\n");
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (/[ \t]+$/u.test(lines[index]!)) findings.push({ kind: "trailing-whitespace", line: index + 1 });
  }
  return deepFreeze(findings);
}

function formatTextFinding(path: string, finding: TextFinding): string {
  const line = finding.line === undefined ? "" : `:line-${finding.line}`;
  return `candidate-text-${finding.kind}:${safePathLabel(path)}${line}`;
}

function safePathLabel(path: string): string {
  try {
    return encodeURIComponent(path);
  } catch {
    return `sha256-${canonicalHash({ path })}`;
  }
}
