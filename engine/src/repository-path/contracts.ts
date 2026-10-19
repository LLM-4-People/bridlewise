import { deepFreeze } from "../kernel/integrity.ts";
import { schemaId } from "../kernel/product-identity.ts";

export const REPOSITORY_PATH_SETTINGS_SCHEMA_VERSION =
  schemaId("repository-path-settings", 1);
export const REPOSITORY_PATH_PROFILE = "cross-platform-strict/v1" as const;
export const REPOSITORY_PATH_UNICODE_VERSION = "17.0.0" as const;
export const REPOSITORY_PATH_QUALIFIED_RUNTIME_CAPABILITIES = deepFreeze({
  unicodeVersion: "17.0",
  icuVersion: "78.3",
} as const);
export const REPOSITORY_PATH_PORTABILITY_KEY_ALGORITHM =
  "NFC(toCasefold(NFD(X)))/unicode-17.0.0-C+F" as const;

/** Qualification ceilings are protocol safety bounds, never runtime defaults. */
export const REPOSITORY_PATH_QUALIFIED_LIMIT_CEILINGS = deepFreeze({
  maximumPathUtf8Bytes: 4_096,
  maximumSegmentUtf8Bytes: 255,
  maximumSegmentUtf16CodeUnits: 255,
  maximumSegments: 256,
  maximumPathsPerSet: 100_000,
} as const);

export const REPOSITORY_PATH_VIOLATION_CODES = deepFreeze([
  "repository_path_type_invalid",
  "repository_path_empty",
  "repository_path_absolute",
  "repository_path_backslash",
  "repository_path_empty_segment",
  "repository_path_dot_segment",
  "repository_path_lone_surrogate",
  "repository_path_non_nfc",
  "repository_path_forbidden_code_point",
  "repository_path_win32_character",
  "repository_path_win32_trailing_dot_or_space",
  "repository_path_win32_reserved_device",
  "repository_path_git_metadata_alias",
  "repository_path_git_symlink_metadata_alias",
  "repository_path_too_many_segments",
  "repository_path_segment_utf8_too_large",
  "repository_path_segment_utf16_too_large",
  "repository_path_utf8_too_large",
  "repository_path_set_structure_invalid",
  "repository_path_set_too_large",
  "repository_path_exact_duplicate",
  "repository_path_portable_collision",
] as const);
export const REPOSITORY_PATH_ENTRY_KINDS = deepFreeze([
  "file",
  "directory",
  "symlink",
  "gitlink",
] as const);
export const REPOSITORY_PATH_GIT_MODES = deepFreeze([
  "100644",
  "100755",
  "120000",
  "160000",
] as const);

/**
 * Git's fallback aliases are always eight characters: a zero-to-six character
 * prefix, a tilde, and one-to-seven digits whose first digit is non-zero. The
 * prefix shortens as the sequence widens through 9,999,999. The harness-only
 * regular range remains separate from Git's exact rule.
 */
export const REPOSITORY_PATH_GIT_SYMLINK_ALIAS_POLICY = deepFreeze({
  gitExact: {
    metadataNames: [
      { longName: ".gitmodules", fallbackShortPrefix: "gi7eba" },
      { longName: ".gitattributes", fallbackShortPrefix: "gi7d29" },
      { longName: ".gitignore", fallbackShortPrefix: "gi250a" },
      { longName: ".mailmap", fallbackShortPrefix: "maba30" },
    ],
    regularShortName: {
      prefixLength: 6,
      minimumSequence: 1,
      maximumSequence: 4,
    },
    fallbackShortName: {
      totalLength: 8,
      maximumPrefixLength: 6,
      minimumSequence: 1,
      maximumSequence: 9_999_999,
    },
  },
  harnessStrictAdditional: {
    regularShortName: {
      minimumSequence: 5,
      maximumSequence: 9,
    },
  },
} as const);

export const REPOSITORY_PATH_RUNTIME_AUTHORITY_ERROR_CODE =
  "repository_path_runtime_authority_invalid" as const;

export type RepositoryPathViolationCode = typeof REPOSITORY_PATH_VIOLATION_CODES[number];
export type RepositoryPathEntryKind = typeof REPOSITORY_PATH_ENTRY_KINDS[number];
export type RepositoryPathGitMode = typeof REPOSITORY_PATH_GIT_MODES[number];

declare const REPOSITORY_RELATIVE_PATH_BRAND: unique symbol;
export type RepositoryRelativePath = string & {
  readonly [REPOSITORY_RELATIVE_PATH_BRAND]: true;
};

export type RepositoryPathLimits = Readonly<{
  maximumPathUtf8Bytes: number;
  maximumSegmentUtf8Bytes: number;
  maximumSegmentUtf16CodeUnits: number;
  maximumSegments: number;
  maximumPathsPerSet: number;
}>;

export type RepositoryPathContext = Readonly<{
  entryKind?: RepositoryPathEntryKind;
  gitMode?: RepositoryPathGitMode;
}>;

export type RepositoryPathSetInput = Readonly<{
  value: unknown;
  context?: RepositoryPathContext;
}>;

export type RepositoryPathViolation = Readonly<{
  code: RepositoryPathViolationCode;
  segmentIndex?: number;
}>;

export type ValidRepositoryPath = Readonly<{
  value: RepositoryRelativePath;
  segments: readonly string[];
  utf8Bytes: number;
  portabilityKey: string;
  portabilityKeySha256: string;
}>;

export type RepositoryPathDecision =
  | Readonly<{ ok: true; path: ValidRepositoryPath }>
  | Readonly<{ ok: false; violations: readonly RepositoryPathViolation[] }>;

export type RepositoryPathSetMember = Readonly<{
  ordinal: number;
}>;

export type RepositoryPathSetFinding = Readonly<{
  code: "repository_path_exact_duplicate" | "repository_path_portable_collision";
  first: RepositoryPathSetMember;
  second: RepositoryPathSetMember;
}>;

export type RepositoryPathSetPathViolation = Readonly<{
  ordinal: number;
  violations: readonly RepositoryPathViolation[];
}>;

export type RepositoryPathSetDecision =
  | Readonly<{ ok: true; paths: readonly ValidRepositoryPath[] }>
  | Readonly<{
      ok: false;
      violations: readonly RepositoryPathViolation[];
      pathViolations: readonly RepositoryPathSetPathViolation[];
      collisions: readonly RepositoryPathSetFinding[];
    }>;
