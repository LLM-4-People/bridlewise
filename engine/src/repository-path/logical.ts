import { InputError, SecurityError } from "../kernel/errors.ts";
import { deepFreeze, sha256 } from "../kernel/integrity.ts";
import { snapshotJsonValue, snapshotPlainRecord } from "../kernel/safe-structural.ts";
import { readNodeRuntimeCapabilities } from "../runtime/runtime-capabilities.ts";
import {
  REPOSITORY_PATH_ENTRY_KINDS,
  REPOSITORY_PATH_GIT_SYMLINK_ALIAS_POLICY,
  REPOSITORY_PATH_GIT_MODES,
  REPOSITORY_PATH_QUALIFIED_RUNTIME_CAPABILITIES,
  REPOSITORY_PATH_QUALIFIED_LIMIT_CEILINGS,
  REPOSITORY_PATH_RUNTIME_AUTHORITY_ERROR_CODE,
  REPOSITORY_PATH_UNICODE_VERSION,
  type RepositoryPathContext,
  type RepositoryPathDecision,
  type RepositoryPathLimits,
  type RepositoryPathViolation,
  type RepositoryPathViolationCode,
  type RepositoryRelativePath,
  type ValidRepositoryPath,
} from "./contracts.ts";
import {
  UNICODE_CASE_FOLDING_ENTRY_COUNT,
  UNICODE_CASE_FOLDING_SOURCE_SHA256,
  UNICODE_CASE_FOLDING_TABLE,
  UNICODE_CASE_FOLDING_TABLE_BYTE_LENGTH,
  UNICODE_CASE_FOLDING_TABLE_JSON,
  UNICODE_CASE_FOLDING_TABLE_SHA256,
  UNICODE_CASE_FOLDING_VERSION,
} from "./unicode-case-fold.generated.ts";

const LIMIT_KEYS = Object.keys(REPOSITORY_PATH_QUALIFIED_LIMIT_CEILINGS) as
  Array<keyof RepositoryPathLimits>;
const ENTRY_KINDS = new Set<string>(REPOSITORY_PATH_ENTRY_KINDS);
const GIT_MODES = new Set<string>(REPOSITORY_PATH_GIT_MODES);
const FORBIDDEN_CATEGORY = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const WIN32_FORBIDDEN_CHARACTER = /[<>:"|?*]/u;
const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:[/\\]/u;
const TRAILING_DOT_OR_SPACE = /[. ]$/u;
const TRAILING_SPACES = / +$/u;
const GIT_METADATA_ALIAS = /^(?:\.git|git~1)[. ]*$/u;
const WIN32_RESERVED_DEVICE_BASENAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "conin$",
  "conout$",
  "clock$",
  ...Array.from({ length: 9 }, (_unused, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_unused, index) => `lpt${index + 1}`),
  "com¹",
  "com²",
  "com³",
  "lpt¹",
  "lpt²",
  "lpt³",
]);

const CASE_FOLDING_MAP = buildCaseFoldingMap();
const MINTED_REPOSITORY_PATHS = new WeakSet<ValidRepositoryPath>();
let runtimeCapabilityChecked = false;

export type RepositoryPathInspector = Readonly<{
  limits: RepositoryPathLimits;
  inspect: (input: unknown, context?: RepositoryPathContext) => RepositoryPathDecision;
}>;

export function assertRepositoryPathRuntimeCapability(): void {
  if (runtimeCapabilityChecked) return;
  const capabilities = readNodeRuntimeCapabilities();
  if (capabilities.unicodeVersion !== REPOSITORY_PATH_QUALIFIED_RUNTIME_CAPABILITIES.unicodeVersion ||
    capabilities.icuVersion !== REPOSITORY_PATH_QUALIFIED_RUNTIME_CAPABILITIES.icuVersion ||
    UNICODE_CASE_FOLDING_VERSION !== REPOSITORY_PATH_UNICODE_VERSION) {
    throw new SecurityError(
      "Repository path Unicode capability is unavailable",
      "repository_path_runtime_unicode_unavailable",
    );
  }
  if ("e\u0301".normalize("NFC") !== "é" || "Å".normalize("NFC") !== "Å") {
    throw new SecurityError(
      "Repository path normalization capability is unavailable",
      "repository_path_runtime_normalization_unavailable",
    );
  }
  runtimeCapabilityChecked = true;
}

export function inspectRepositoryPath(
  input: unknown,
  limits: RepositoryPathLimits,
  context: RepositoryPathContext = {},
): RepositoryPathDecision {
  return createRepositoryPathInspector(limits).inspect(input, context);
}

export function createRepositoryPathInspector(limits: RepositoryPathLimits): RepositoryPathInspector {
  const acceptedLimits = validateRepositoryPathLimits(limits);
  return deepFreeze({
    limits: acceptedLimits,
    inspect: (input: unknown, context: RepositoryPathContext = {}) =>
      inspectRepositoryPathWithValidatedLimits(
        input,
        acceptedLimits,
        validateRepositoryPathContext(context),
      ),
  });
}

function inspectRepositoryPathWithValidatedLimits(
  input: unknown,
  limits: RepositoryPathLimits,
  context: RepositoryPathContext = {},
): RepositoryPathDecision {
  assertRepositoryPathRuntimeCapability();
  if (typeof input !== "string") return rejected([{ code: "repository_path_type_invalid" }]);
  if (hasLoneSurrogate(input)) return rejected([{ code: "repository_path_lone_surrogate" }]);

  const violations: RepositoryPathViolation[] = [];
  if (input.length === 0) addViolation(violations, "repository_path_empty");
  if (input.startsWith("/") || WINDOWS_DRIVE_ABSOLUTE.test(input)) {
    addViolation(violations, "repository_path_absolute");
  }
  if (input.includes("\\")) addViolation(violations, "repository_path_backslash");
  if (input !== input.normalize("NFC")) addViolation(violations, "repository_path_non_nfc");

  const segments = input.split("/");
  if (segments.length > limits.maximumSegments) {
    addViolation(violations, "repository_path_too_many_segments");
  }
  const symlinkContext = context.entryKind === "symlink" || context.gitMode === "120000";
  for (const [segmentIndex, segment] of segments.entries()) {
    if (segment.length === 0) addViolation(violations, "repository_path_empty_segment", segmentIndex);
    if (segment === "." || segment === "..") {
      addViolation(violations, "repository_path_dot_segment", segmentIndex);
    }
    if (FORBIDDEN_CATEGORY.test(segment)) {
      addViolation(violations, "repository_path_forbidden_code_point", segmentIndex);
    }
    if (WIN32_FORBIDDEN_CHARACTER.test(segment)) {
      addViolation(violations, "repository_path_win32_character", segmentIndex);
    }
    if (TRAILING_DOT_OR_SPACE.test(segment)) {
      addViolation(violations, "repository_path_win32_trailing_dot_or_space", segmentIndex);
    }
    if (isWin32ReservedDevice(segment)) {
      addViolation(violations, "repository_path_win32_reserved_device", segmentIndex);
    }
    const segmentKey = canonicalCaseKey(segment);
    if (GIT_METADATA_ALIAS.test(segmentKey)) {
      addViolation(violations, "repository_path_git_metadata_alias", segmentIndex);
    }
    if (symlinkContext && isGitSymlinkMetadataAlias(segment)) {
      addViolation(violations, "repository_path_git_symlink_metadata_alias", segmentIndex);
    }
    if (segment.length > limits.maximumSegmentUtf16CodeUnits) {
      addViolation(violations, "repository_path_segment_utf16_too_large", segmentIndex);
    }
    if (Buffer.byteLength(segment, "utf8") > limits.maximumSegmentUtf8Bytes) {
      addViolation(violations, "repository_path_segment_utf8_too_large", segmentIndex);
    }
  }

  const utf8Bytes = Buffer.byteLength(input, "utf8");
  if (utf8Bytes > limits.maximumPathUtf8Bytes) {
    addViolation(violations, "repository_path_utf8_too_large");
  }
  if (violations.length > 0) return rejected(violations);

  const value = input as RepositoryRelativePath;
  const portabilityKey = canonicalCaseKey(value);
  const path: ValidRepositoryPath = deepFreeze({
    value,
    segments: [...segments],
    utf8Bytes,
    portabilityKey,
    portabilityKeySha256: sha256(portabilityKey),
  });
  MINTED_REPOSITORY_PATHS.add(path);
  return deepFreeze({ ok: true, path });
}

export function requireRepositoryPath(
  input: unknown,
  limits: RepositoryPathLimits,
  context: RepositoryPathContext = {},
): ValidRepositoryPath {
  const decision = inspectRepositoryPath(input, limits, context);
  if (decision.ok) return decision.path;
  throw new InputError("Repository path is invalid", decision.violations[0]!.code);
}

export function portableRepositoryPathKey(path: ValidRepositoryPath): string {
  assertRepositoryPathRuntimeCapability();
  if (typeof path !== "object" || path === null || !MINTED_REPOSITORY_PATHS.has(path)) {
    throw new SecurityError(
      "Repository path runtime authority is invalid",
      REPOSITORY_PATH_RUNTIME_AUTHORITY_ERROR_CODE,
    );
  }
  return path.portabilityKey;
}

function canonicalCaseKey(input: string): string {
  let result = "";
  for (const character of input.normalize("NFD")) {
    const codePoint = character.codePointAt(0)!;
    const mapped = CASE_FOLDING_MAP.get(codePoint);
    result += mapped === undefined ? character : String.fromCodePoint(...mapped);
  }
  return result.normalize("NFC");
}

function isWin32ReservedDevice(segment: string): boolean {
  const separator = segment.indexOf(".");
  const basename = (separator === -1 ? segment : segment.slice(0, separator)).replace(TRAILING_SPACES, "");
  return WIN32_RESERVED_DEVICE_BASENAMES.has(canonicalCaseKey(basename));
}

function isGitSymlinkMetadataAlias(segment: string): boolean {
  for (const metadata of REPOSITORY_PATH_GIT_SYMLINK_ALIAS_POLICY.gitExact.metadataNames) {
    if (matchesGitLongName(segment, metadata.longName) ||
      matchesGitRegularShortName(
        segment,
        metadata.longName,
        REPOSITORY_PATH_GIT_SYMLINK_ALIAS_POLICY.gitExact.regularShortName.minimumSequence,
        REPOSITORY_PATH_GIT_SYMLINK_ALIAS_POLICY.gitExact.regularShortName.maximumSequence,
      ) || matchesGitFallbackShortName(segment, metadata.fallbackShortPrefix) ||
      matchesGitRegularShortName(
        segment,
        metadata.longName,
        REPOSITORY_PATH_GIT_SYMLINK_ALIAS_POLICY.harnessStrictAdditional.regularShortName.minimumSequence,
        REPOSITORY_PATH_GIT_SYMLINK_ALIAS_POLICY.harnessStrictAdditional.regularShortName.maximumSequence,
      )) return true;
  }
  return false;
}

function matchesGitLongName(input: string, longName: string): boolean {
  return hasAsciiCaseInsensitivePrefix(input, longName) && hasGitNtfsAliasSuffix(input, longName.length);
}

function matchesGitRegularShortName(
  input: string,
  longName: string,
  minimumSequence: number,
  maximumSequence: number,
): boolean {
  const rule = REPOSITORY_PATH_GIT_SYMLINK_ALIAS_POLICY.gitExact.regularShortName;
  const prefix = longName.slice(1, rule.prefixLength + 1);
  if (!hasAsciiCaseInsensitivePrefix(input, prefix) || input[rule.prefixLength] !== "~") return false;
  const sequenceCharacter = input[rule.prefixLength + 1];
  if (sequenceCharacter === undefined) return false;
  const sequence = sequenceCharacter.charCodeAt(0) - 0x30;
  return sequence >= minimumSequence && sequence <= maximumSequence &&
    hasGitNtfsAliasSuffix(input, rule.prefixLength + 2);
}

function matchesGitFallbackShortName(input: string, fallbackPrefix: string): boolean {
  const rule = REPOSITORY_PATH_GIT_SYMLINK_ALIAS_POLICY.gitExact.fallbackShortName;
  if (input.length < rule.totalLength) return false;
  const alias = input.slice(0, rule.totalLength);
  const tildeIndex = alias.indexOf("~");
  if (tildeIndex < 0 || tildeIndex > rule.maximumPrefixLength ||
    !hasAsciiCaseInsensitivePrefix(alias, fallbackPrefix.slice(0, tildeIndex))) return false;
  const digits = alias.slice(tildeIndex + 1);
  if (!/^[1-9][0-9]*$/u.test(digits)) return false;
  const sequence = Number(digits);
  return sequence >= rule.minimumSequence && sequence <= rule.maximumSequence &&
    hasGitNtfsAliasSuffix(input, rule.totalLength);
}

function hasAsciiCaseInsensitivePrefix(input: string, expected: string): boolean {
  if (input.length < expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    const inputCode = input.charCodeAt(index);
    const expectedCode = expected.charCodeAt(index);
    const foldedInput = inputCode >= 0x41 && inputCode <= 0x5a ? inputCode + 0x20 : inputCode;
    if (foldedInput !== expectedCode) return false;
  }
  return true;
}

function hasGitNtfsAliasSuffix(input: string, matchedLength: number): boolean {
  for (let index = matchedLength; index < input.length; index += 1) {
    const character = input[index]!;
    if (character === ":") return true;
    if (character !== "." && character !== " ") return false;
  }
  return true;
}

function hasLoneSurrogate(input: string): boolean {
  for (let index = 0; index < input.length; index += 1) {
    const unit = input.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= input.length) return true;
      const next = input.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function validateRepositoryPathLimits(input: RepositoryPathLimits): RepositoryPathLimits {
  const snapshot = snapshotPlainRecord(
    input,
    LIMIT_KEYS,
    { maximumDepth: 2, maximumNodes: 16 },
    "repository_path_limits_invalid",
  );
  for (const key of LIMIT_KEYS) {
    const value = snapshot[key];
    if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 1 ||
      value > REPOSITORY_PATH_QUALIFIED_LIMIT_CEILINGS[key]) {
      throw new InputError("Repository path limits are invalid", "repository_path_limits_invalid");
    }
  }
  return snapshot as RepositoryPathLimits;
}

export function validateRepositoryPathContext(input: RepositoryPathContext): RepositoryPathContext {
  const snapshot = snapshotJsonValue(
    input,
    { maximumDepth: 2, maximumNodes: 8 },
    "repository_path_context_invalid",
  );
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new InputError("Repository path context is invalid", "repository_path_context_invalid");
  }
  const contextRecord = snapshot as Readonly<Record<string, unknown>>;
  const keys = Object.keys(contextRecord);
  if (keys.some((key) => key !== "entryKind" && key !== "gitMode")) {
    throw new InputError("Repository path context is invalid", "repository_path_context_invalid");
  }
  const entryKind = contextRecord.entryKind;
  const gitMode = contextRecord.gitMode;
  if (entryKind !== undefined && (typeof entryKind !== "string" || !ENTRY_KINDS.has(entryKind))) {
    throw new InputError("Repository path context is invalid", "repository_path_context_invalid");
  }
  if (gitMode !== undefined && (typeof gitMode !== "string" || !GIT_MODES.has(gitMode))) {
    throw new InputError("Repository path context is invalid", "repository_path_context_invalid");
  }
  if (entryKind === undefined && gitMode === undefined) return deepFreeze({});
  if (entryKind === undefined) return deepFreeze({ gitMode: gitMode as NonNullable<RepositoryPathContext["gitMode"]> });
  if (gitMode === undefined) {
    return deepFreeze({ entryKind: entryKind as NonNullable<RepositoryPathContext["entryKind"]> });
  }
  return deepFreeze({
    entryKind: entryKind as NonNullable<RepositoryPathContext["entryKind"]>,
    gitMode: gitMode as NonNullable<RepositoryPathContext["gitMode"]>,
  });
}

function buildCaseFoldingMap(): ReadonlyMap<number, readonly number[]> {
  if (UNICODE_CASE_FOLDING_SOURCE_SHA256.length !== 64 ||
    UNICODE_CASE_FOLDING_TABLE.length !== UNICODE_CASE_FOLDING_ENTRY_COUNT ||
    Buffer.byteLength(UNICODE_CASE_FOLDING_TABLE_JSON, "utf8") !== UNICODE_CASE_FOLDING_TABLE_BYTE_LENGTH ||
    sha256(UNICODE_CASE_FOLDING_TABLE_JSON) !== UNICODE_CASE_FOLDING_TABLE_SHA256) {
    throw new SecurityError("Generated case-folding authority is invalid", "repository_path_case_folding_invalid");
  }
  const result = new Map<number, readonly number[]>();
  let previous = -1;
  for (const [source, mapping] of UNICODE_CASE_FOLDING_TABLE) {
    if (!isUnicodeScalar(source) || source <= previous || mapping.length < 1 || mapping.length > 3 ||
      mapping.some((entry) => !isUnicodeScalar(entry))) {
      throw new SecurityError("Generated case-folding table is invalid", "repository_path_case_folding_invalid");
    }
    result.set(source, mapping);
    previous = source;
  }
  return result;
}

function isUnicodeScalar(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0x10ffff &&
    (value < 0xd800 || value > 0xdfff);
}

function addViolation(
  target: RepositoryPathViolation[],
  code: RepositoryPathViolationCode,
  segmentIndex?: number,
): void {
  if (target.some((entry) => entry.code === code && entry.segmentIndex === segmentIndex)) return;
  target.push(segmentIndex === undefined ? { code } : { code, segmentIndex });
}

function rejected(violations: readonly RepositoryPathViolation[]): RepositoryPathDecision {
  return deepFreeze({ ok: false, violations: [...violations] });
}
