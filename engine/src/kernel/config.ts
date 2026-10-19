import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  type BigIntStats,
  type Dirent,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { describeSchemaIssues, InputError, SecurityError } from "./errors.ts";
import { hasSecondName } from "../filesystem/link-containment.ts";
import { canonicalHash, deepFreeze, sha256 } from "./integrity.ts";
import { assertNoDuplicateJsonObjectKeys } from "./json-integrity.ts";
import { hasTraversalSegment, readLinuxMountPoints } from "../filesystem/linux-path.ts";
import { ROOT_POLICY } from "./root-policy.ts";
import { engineRoot } from "./engine-root.ts";
import { getConfigDocumentSchema, type ConfigDocument } from "./config-contracts.ts";
import { sameIdentity } from "../shared/identity.ts";
import { CONFIG_MODE_REQUIRE_ENV_VAR } from "../shared/source-scan.ts";

export { getConfigDocumentSchema } from "./config-contracts.ts";
export type { ConfigDocument } from "./config-contracts.ts";

const REPOSITORY_SCAN_EXCLUSIONS = new Set<string>(ROOT_POLICY.configuration.repositoryScanExclusions);
const REPOSITORY_SCAN_FILE_EXCLUSIONS = new Set<string>(ROOT_POLICY.configuration.repositoryScanFileExclusions);
const REPOSITORY_SCAN_FILE_SUFFIX_EXCLUSIONS = ROOT_POLICY.configuration.repositoryScanFileSuffixExclusions;
const REQUIRED_CONFIG_MODE = BigInt(`0o${ROOT_POLICY.configuration.requiredConfigFileMode}`);

const PLATFORM_SUPPORTS_MOUNTINFO = process.platform === "linux";
let nonLinuxMountpointWarningEmitted = false;

/**
 * Returns the active mount-point set for the current platform. On Linux this
 * reads `/proc/self/mountinfo` (the S1 security floor). On non-Linux platforms
 * the mount-point check is unavailable, so an empty set is returned and a
 * single warning is emitted explaining that mount-point verification is
 * skipped. The cross-device check (`stats.dev`) still runs on every platform.
 */
function readPlatformMountPoints(): ReadonlySet<string> {
  if (PLATFORM_SUPPORTS_MOUNTINFO) return readLinuxMountPoints();
  if (!nonLinuxMountpointWarningEmitted) {
    nonLinuxMountpointWarningEmitted = true;
    process.emitWarning(
      `Mount-point verification is skipped on non-Linux platform ${process.platform}`,
      { type: "SecurityWarning", code: "mountpoint_check_skipped_non_linux" },
    );
  }
  return new Set<string>();
}

export type SourceIdentity = Readonly<{
  device: string;
  inode: string;
  mode: string;
  ownerUid: number;
  ownerGid: number;
  links: string;
  size: string;
  modifiedNanoseconds: string;
  changedNanoseconds: string;
}>;

export type ConfigSourceIdentity = Readonly<SourceIdentity & {
  path: string;
  parent: SourceIdentity;
  parentEntriesHash: string;
}>;

export type ConfigSnapshot = Readonly<{
  document: ConfigDocument;
  canonicalHash: string;
  sourceHash: string;
  source: ConfigSourceIdentity;
  /**
   * Absolute path to the harness installation root, pinned via
   * `import.meta.url`. The harness's own config, source, and binary live
   * here. This is the canonical authority for config loading and for any
   * harness-self integrity check; it must NOT be used as the working
   * directory for project-scoped tools or state.
   */
  repositoryRoot: string;
  /**
   * Absolute path to the user's project root — the directory the harness was
   * invoked from (`process.cwd` at config-load time, overridable via the
   * `--project` CLI flag). All project-scoped tools (list_files, read_file,
    * edit, search_code, git_status,...) and per-project state
   * (`.bridlewise/state/`) operate relative to this root, NOT to the
   * harness installation root. Splitting `projectRoot` from
   * `repositoryRoot` fixes the bug where the harness operated on its own
   * source tree instead of the user's project when invoked from a different
   * directory.
   */
  projectRoot: string;
  repositoryManifestHash: string;
}>;

type DirectorySnapshot = Readonly<{
  identity: BigIntStats;
  entriesHash: string;
}>;

type DirectoryEntryIdentity = Readonly<{
  name: string;
  type: string;
  device: string;
  inode: string;
  mode: string;
  ownerUid: string;
  ownerGid: string;
  links: string;
  size: string;
  modifiedNanoseconds: string;
  changedNanoseconds: string;
}>;

/**
 * Reads only the configuration adjacent to this runtime's src directory. There
 * is deliberately no path argument and NO ENVIRONMENT OVERRIDE: the former
 * `HARNESS_CONFIG_SNAPSHOT` fast path let any process that inherited that
 * variable replace the config file with the variable's contents (it existed
 * for the CLI's guardian re-exec, deleted by user decision C8).
 */
export function loadPinnedConfigSnapshot(): ConfigSnapshot {
  const declaredRoot = engineRoot();
  const root = assertPinnedRepositoryRoot(declaredRoot);
  const configPath = configDocumentPath(root);
  const rootDescriptor = openDirectory(root, "project_root_open_denied");
  try {
    const rootBefore = inspectDirectory(root, rootDescriptor);
    const manifestBefore = inspectRepositoryConfigSurface(root, rootBefore.identity.dev);
    const first = readConfigDescriptor(configPath, rootBefore.identity);
    const second = readConfigDescriptor(configPath, rootBefore.identity);
    const rootAfter = inspectDirectory(root, rootDescriptor);
    const manifestAfter = inspectRepositoryConfigSurface(root, rootAfter.identity.dev);

    if (!sameIdentity(rootBefore.identity, rootAfter.identity) ||
      rootBefore.entriesHash !== rootAfter.entriesHash ||
      manifestBefore !== manifestAfter) {
      throw new SecurityError("Repository root changed during configuration bootstrap", "config_parent_changed");
    }
    if (!sameIdentity(first.stats, second.stats) || first.sourceHash !== second.sourceHash) {
      throw new SecurityError("Configuration changed during descriptor verification", "config_identity_changed");
    }

    const document = parseConfigDocument(first.bytes);
    const source = deepFreeze({
      path: configPath,
      ...sourceIdentity(first.stats),
      parent: sourceIdentity(rootAfter.identity),
      parentEntriesHash: rootAfter.entriesHash,
    });
    return deepFreeze({
      document,
      canonicalHash: canonicalHash(document),
      sourceHash: first.sourceHash,
      source,
      repositoryRoot: root,
      projectRoot: process.cwd(),
      repositoryManifestHash: manifestAfter,
    });
  } finally {
    closeSync(rootDescriptor);
  }
}

/**
 * The ONE refusal code that means "there is no configuration document", as
 * opposed to "there is one and it was refused". Only this code may ever be
 * answered with "run unconfigured"; see {@link isConfigAbsent}.
 */
const CONFIG_ABSENT_CODE = "config_not_found";

/**
 * THE ONE ABSENCE PREDICATE. A refusal is "absent" only when the loader or
 * the raw reader found no directory entry at the document path; every other
 * refusal (unreadable, not UTF-8, not JSON, a duplicate key, not an object,
 * an alternate, a link alias, a mode or identity breach, a schema breach) is
 * a finding the operator must see and never a quiet default.
 */
function isConfigAbsent(error: unknown): boolean {
  return error instanceof SecurityError && error.code === CONFIG_ABSENT_CODE;
}

function absentAsUndefined<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch (error) {
    if (isConfigAbsent(error)) return undefined;
    throw error;
  }
}

/**
 * A CONFIGURATION REFUSAL IS NEVER A QUIET DEFAULT — THE ONE DOOR FOR "NONE".
 *
 * `loadPinnedConfigSnapshot` refuses a document for many reasons: an alternate
 * `*.config.json` planted beside it, a symlink or hardlink alias, a mode, owner
 * or identity violation, a schema breach. Every one of those is a finding the
 * operator must see. A caller that catches the refusal and carries on — with
 * section defaults, or with self-protection off — turns a planted file into a
 * silent downgrade: the measured case was the CLI's self-protection bootstrap,
 * which answered ANY refusal with "dev mode, unprotected".
 *
 * The only legitimate "no configuration" answer is an ABSENT document (a tree
 * that has none yet, e.g. preflight before setup), and that is decided HERE,
 * by the typed absence code, not by each caller's catch. Everything else
 * propagates. No other module catches a config load: the prevention guard
 * `config-refusal-propagates.test.ts` refuses a `try`/`catch` or a
 * best-effort wrapper around any config read anywhere in the engine.
 */
export function loadPinnedConfigSnapshotIfPresent(): ConfigSnapshot | undefined {
  return absentAsUndefined(() => loadPinnedConfigSnapshot());
}

/** The configuration document's path inside a harness root. */
export function configDocumentPath(root: string): string {
  return join(root, ROOT_POLICY.configuration.basename);
}

/**
 * THE ENGINE'S OWN CONFIG DOCUMENT — the one spelling of where it lives: the
 * engine root found from this module's own location (the root-policy owner's
 * directory, see `engine-root.ts`), plus the policy basename. The web
 * server's default (`server/kernel/config.ts`), the engine's customization
 * store and the dev launcher all read it here; three hand-derived copies
 * (four `dirname`s, a `../../engine/...` URL, a `join(cwd, "engine", ...)`)
 * existed before (wf1a-design L4).
 */
export function engineConfigDocumentPath(): string {
  return configDocumentPath(engineRoot());
}

/**
 * THE ONE UNVERIFIED DOCUMENT DECODER (bytes or text → a JSON object), shared
 * by {@link readConfigDocumentRaw} and the web server's cached reader so a
 * corrupt document is refused with the same typed code everywhere: not UTF-8
 * (`config_encoding_invalid`), a duplicate key (`config_key_duplicate`), not
 * JSON (`config_json_invalid`), or not a JSON object (`config_document_not_object`).
 * It never answers a failure with an empty document.
 */
export function decodeConfigDocumentRaw(source: Buffer | string): Record<string, unknown> {
  let text: string;
  if (typeof source === "string") {
    text = source;
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(source);
    } catch {
      throw new InputError("Configuration must be valid UTF-8", "config_encoding_invalid");
    }
  }
  assertNoDuplicateJsonObjectKeys(text, "Configuration contains a duplicate key", "config_key_duplicate");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new InputError("Configuration must be valid JSON", "config_json_invalid");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InputError("Configuration must be a JSON object", "config_document_not_object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * The unverified config-document reader for bootstrap-time accessors (e.g.
 * `shared/dev-mode-env.ts`), the engine's customization store and the web
 * server — every reader that needs the document at an explicit path, BEFORE
 * or outside the security-verified {@link loadPinnedConfigSnapshot}. It does
 * NOT verify the file mode, owner, TOCTOU identity, mountpoint or schema.
 *
 * Absence is the typed `config_not_found` refusal (use
 * {@link readConfigDocumentRawIfPresent} for the one legitimate "none"
 * answer); an unreadable file is `config_read_failed`; every decode failure is
 * {@link decodeConfigDocumentRaw}'s typed refusal. `config.ts` remains the
 * single config-document reader — no other module parses the document.
 */
export function readConfigDocumentRaw(configPath: string): Record<string, unknown> {
  if (lstatSync(configPath, { throwIfNoEntry: false }) === undefined) {
    throw new SecurityError("Configuration document is absent", CONFIG_ABSENT_CODE);
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(configPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code ?? "unknown";
    throw new InputError(`Configuration could not be read (${code})`, "config_read_failed");
  }
  return decodeConfigDocumentRaw(bytes);
}

/** {@link readConfigDocumentRaw}, answering ONLY an absent document with `undefined`. */
export function readConfigDocumentRawIfPresent(configPath: string): Record<string, unknown> | undefined {
  return absentAsUndefined(() => readConfigDocumentRaw(configPath));
}

export type ConfigDocumentInspection = Readonly<
  { state: "absent" } | { state: "ok"; document: Record<string, unknown> } | { state: "unreadable"; code: string; message: string }
>;

/**
 * The document's state as DATA — for the few callers whose answer to a
 * refusal is to REPORT it (a verifier's violation, the web server's
 * configuration signal and its typed boot refusal), never to carry on past
 * it with a default. Decided HERE, in the owner, so no caller wraps a config
 * read in a `catch` (`config-refusal-propagates.test.ts`).
 */
export function inspectConfigDocument(configPath: string): ConfigDocumentInspection {
  try {
    const document = readConfigDocumentRawIfPresent(configPath);
    return document === undefined ? { state: "absent" } : { state: "ok", document };
  } catch (error) {
    return unreadableInspection(error);
  }
}

/**
 * {@link inspectConfigDocument} for bytes the caller already read (the web
 * server's resolved snapshot compares the text before it decodes): the decode
 * refusal as DATA, decided here so no caller catches a config decode.
 */
export function inspectConfigDocumentBytes(source: Buffer | string): Exclude<ConfigDocumentInspection, { state: "absent" }> {
  try {
    return { state: "ok", document: decodeConfigDocumentRaw(source) };
  } catch (error) {
    return unreadableInspection(error);
  }
}

function unreadableInspection(error: unknown): Extract<ConfigDocumentInspection, { state: "unreadable" }> {
  const code = (error as { code?: unknown } | null)?.code;
  return { state: "unreadable", code: typeof code === "string" ? code : "config_read_failed", message: error instanceof Error ? error.message : String(error) };
}

/**
 * THE SETTINGS STORE'S STATE — the one type every reporter of it shares (the
 * web server's resolved snapshot, the `settings.storeState` signal, the boot
 * refusal). `absent`: no document, every setting at its default; `ok`;
 * `unreadable`: the store cannot be read, or was removed after a good
 * document was read (the reason carries the decoder's code and message;
 * `config_unreadable` is the one refusal code); `refused`: it decodes but a
 * posture door refuses it (a weakened privacy section). While a store that
 * was readable is `unreadable` or `refused`, a host keeps serving the LAST
 * GOOD snapshot; an `unreadable` store refuses every save.
 */
export type SettingsStoreState = Readonly<{ state: "absent" | "ok" | "unreadable" | "refused"; path: string; reason?: string }>;

function assertPinnedRepositoryRoot(candidate: string): string {
  if (candidate.includes("\0") || hasTraversalSegment(candidate)) {
    throw new SecurityError("Runtime root syntax is invalid", "project_root_invalid");
  }
  const stats = lstatSync(candidate, { bigint: true, throwIfNoEntry: false });
  const uid = process.getuid?.();
  if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new SecurityError("Runtime root must be a non-symlink directory", "project_root_invalid");
  }
  if (uid === undefined || stats.uid !== BigInt(uid)) {
    throw new SecurityError("Runtime root owner does not match the effective user", "project_owner_mismatch");
  }
  let canonical: string;
  try {
    canonical = realpathSync(candidate);
  } catch {
    throw new SecurityError("Runtime root could not be resolved", "project_root_unavailable");
  }
  if (canonical !== candidate) {
    throw new SecurityError("Runtime root must be addressed canonically", "project_root_alias_denied");
  }
  const parentStats = lstatSync(dirname(canonical), { bigint: true });
  if (parentStats.dev !== stats.dev || readPlatformMountPoints().has(canonical)) {
    throw new SecurityError("Mounted runtime roots are not accepted in S1", "project_mountpoint_denied");
  }
  return canonical;
}

function readConfigDescriptor(
  path: string,
  expectedParent: BigIntStats,
): Readonly<{ bytes: Buffer; sourceHash: string; stats: BigIntStats }> {
  const parentPath = dirname(path);
  const parentDescriptor = openDirectory(parentPath, "config_parent_open_denied");
  let descriptor: number | undefined;
  try {
    const parentBefore = inspectDirectory(parentPath, parentDescriptor);
    if (!sameIdentity(parentBefore.identity, expectedParent)) {
      throw new SecurityError("Configuration parent identity changed", "config_parent_changed");
    }
    const before = inspectConfigFile(path, expectedParent.dev);
    try {
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      throw new SecurityError("Configuration could not be opened safely", "config_open_denied");
    }
    const openedBefore = fstatSync(descriptor, { bigint: true });
    if (!openedBefore.isFile() || !sameIdentity(before, openedBefore)) {
      throw new SecurityError("Configuration changed while it was opened", "config_identity_changed");
    }
    const bytes = readFileSync(descriptor);
    const openedAfter = fstatSync(descriptor, { bigint: true });
    const after = inspectConfigFile(path, expectedParent.dev);
    const parentAfter = inspectDirectory(parentPath, parentDescriptor);
    if (!sameIdentity(openedBefore, openedAfter) || !sameIdentity(before, after) ||
      !sameIdentity(parentBefore.identity, parentAfter.identity) ||
      parentBefore.entriesHash !== parentAfter.entriesHash || bytes.length !== Number(after.size)) {
      throw new SecurityError("Configuration changed while it was read", "config_identity_changed");
    }
    return { bytes, sourceHash: sha256(bytes), stats: after };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    closeSync(parentDescriptor);
  }
}

function inspectConfigFile(path: string, expectedDevice: bigint): BigIntStats {
  const stats = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  const uid = process.getuid?.();
  if (!stats) {
    throw new SecurityError("Configuration document is absent", CONFIG_ABSENT_CODE);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new SecurityError("Configuration must be a regular non-symlink file", "config_file_invalid");
  }
  if (stats.dev !== expectedDevice) {
    throw new SecurityError("Configuration crosses the runtime filesystem", "config_mountpoint_denied");
  }
  if (hasSecondName(stats.nlink)) {
    throw new SecurityError("Configuration hardlink aliases are denied", "config_hardlink_denied");
  }
  if (uid === undefined || stats.uid !== BigInt(uid)) {
    throw new SecurityError("Configuration owner does not match the effective user", "config_owner_mismatch");
  }
  if ((stats.mode & 0o7777n) !== REQUIRED_CONFIG_MODE) {
    // Dev-mode bypass: git normalizes tracked file modes to 0644 (it tracks
    // only the executable bit), so a config file under git control is 0644
    // after any commit/checkout — failing the 0600 production floor on
    // every dev run. In dev mode (`selfProtection.enabled: false`), the
    // test runner / CLI sets HARNESS_REQUIRE_CONFIG_MODE=0 via
    // applyDevModeSafeReadEnvVars, mirroring the hardlink/symlink bypass.
    // The config file carries no secrets (the API key lives in the env),
    // so 0644 in a dev workspace is acceptable.
    if (process.env[CONFIG_MODE_REQUIRE_ENV_VAR] !== "0") {
      throw new SecurityError(`Configuration mode must be exactly 0600, found 0${(stats.mode & 0o777n).toString(8)} (a fresh checkout or worktree gives it 0644/0664): chmod 600 the configuration file`, "config_mode_insecure");
    }
  }
  if (stats.size > BigInt(ROOT_POLICY.configuration.maximumBytes)) {
    throw new InputError("Configuration exceeds the root-policy size limit", "config_too_large");
  }
  return stats;
}

function parseConfigDocument(bytes: Buffer): ConfigDocument {
  const untrusted = decodeConfigDocumentRaw(bytes);
  if (hasProjectRootTraversalSyntax(untrusted)) {
    throw new InputError("Project root traversal syntax is forbidden", "project_root_invalid");
  }
  const parsed = getConfigDocumentSchema().safeParse(untrusted);
  if (!parsed.success) {
    // The offending PATHS are part of the message, not just the safeDetails:
    // `safeError()` (what the CLI and the test runner print) projects only
    // `{ error, message, retryable }`, so a detail that lives anywhere else is
    // invisible exactly where the operator is looking. Values are never
    // rendered — see `describeSchemaIssues`.
    const detail = describeSchemaIssues(parsed.error.issues);
    throw new InputError(
      `Configuration does not match the canonical schema: ${detail}`,
      "config_schema_invalid",
      { schemaIssueCount: parsed.error.issues.length },
    );
  }
  return deepFreeze(parsed.data);
}

function inspectDirectory(path: string, descriptor: number): DirectorySnapshot {
  const descriptorStats = fstatSync(descriptor, { bigint: true });
  const pathStats = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (!pathStats || pathStats.isSymbolicLink() || !pathStats.isDirectory() ||
    !sameIdentity(pathStats, descriptorStats)) {
    throw new SecurityError("Directory identity changed", "config_parent_changed");
  }
  return { identity: descriptorStats, entriesHash: directoryEntriesHash(path) };
}

/** The hash of a directory's entries, each held by {@link directoryEntryIdentity}: what a configuration bootstrap compares before and after its reads. */
export function directoryEntriesHash(path: string): string {
  return canonicalHash(readdirSync(path, { withFileTypes: true })
    .map((entry) => directoryEntryIdentity(path, entry))
    .toSorted((left, right) => left.name.localeCompare(right.name)));
}

/**
 * One entry of a directory snapshot. An entry the configuration surface
 * EXCLUDES (`repositoryScanExclusions`: the state directory, `.git`,
 * `node_modules` — never read as configuration) is held by what it IS (its
 * name, type, device, inode, mode and owner: replacing or re-linking it
 * still changes the snapshot), never by its times, size or link count, which
 * move whenever something is made inside it. Held by those, the state
 * directory's churn refused every bootstrap that overlapped it (measured: a
 * full web run's MCP homes and confined scratch folders, made under
 * `<engine>/.bridlewise`, refused 39 reporter drives in a row).
 */
function directoryEntryIdentity(parent: string, entry: Dirent): DirectoryEntryIdentity {
  const stats = lstatSync(join(parent, entry.name), { bigint: true });
  const excluded = REPOSITORY_SCAN_EXCLUSIONS.has(entry.name);
  return {
    name: entry.name,
    type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other",
    device: stats.dev.toString(10),
    inode: stats.ino.toString(10),
    mode: stats.mode.toString(8),
    ownerUid: stats.uid.toString(10),
    ownerGid: stats.gid.toString(10),
    links: excluded ? "" : stats.nlink.toString(10),
    size: excluded ? "" : stats.size.toString(10),
    modifiedNanoseconds: excluded ? "" : stats.mtimeNs.toString(10),
    changedNanoseconds: excluded ? "" : stats.ctimeNs.toString(10),
  };
}

function inspectRepositoryConfigSurface(root: string, expectedDevice: bigint): string {
  return canonicalHash(repositoryConfigSurfaceEntries(root, expectedDevice));
}

/**
 * THE LIVE HARNESS FOLDER'S IDENTITY, exactly what a configuration bootstrap
 * compares before and after its reads: the harness root's own entries
 * ({@link directoryEntriesHash}'s view) and every entry of the configuration
 * surface below it. A test run that changes it can make a concurrent gate
 * fail (`config_parent_changed`): the suites' runners take it before the
 * first test and after the last, and a change fails the run, named
 * ({@link harnessFolderChanges}).
 */
export type HarnessFolderIdentity = Readonly<{
  entries: readonly DirectoryEntryIdentity[];
  surface: readonly Readonly<Record<string, string>>[];
}>;

export function harnessFolderIdentity(root: string): HarnessFolderIdentity {
  const rootStats = lstatSync(root, { bigint: true });
  return deepFreeze({
    entries: readdirSync(root, { withFileTypes: true }).map((entry) => directoryEntryIdentity(root, entry)).toSorted((left, right) => left.name.localeCompare(right.name)),
    surface: repositoryConfigSurfaceEntries(root, rootStats.dev),
  });
}

/** The places whose identity differs between two snapshots (made, removed or changed), each named relative to the root, sorted. */
export function harnessFolderChanges(before: HarnessFolderIdentity, after: HarnessFolderIdentity): readonly string[] {
  const changed = new Set<string>();
  const compare = (left: readonly Readonly<Record<string, string>>[], right: readonly Readonly<Record<string, string>>[], key: (entry: Readonly<Record<string, string>>) => string): void => {
    const byKey = new Map(left.map((entry) => [key(entry), canonicalHash(entry)]));
    for (const entry of right) {
      if (byKey.get(key(entry)) !== canonicalHash(entry)) changed.add(key(entry));
      byKey.delete(key(entry));
    }
    for (const name of byKey.keys()) changed.add(name);
  };
  compare(before.entries, after.entries, (entry) => entry["name"]!);
  compare(before.surface, after.surface, (entry) => entry["path"]!);
  return [...changed].sort();
}

function repositoryConfigSurfaceEntries(root: string, expectedDevice: bigint): readonly Readonly<Record<string, string>>[] {
  const entries: Array<Readonly<Record<string, string>>> = [];
  const alternateConfigs: string[] = [];
  const mountPoints = readPlatformMountPoints();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).toSorted((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      const relativePath = relative(root, path).split(sep).join("/");
      if (hasTraversalSegment(relativePath)) {
        throw new SecurityError("Repository entry traversal syntax is invalid", "repository_path_invalid");
      }
      const stats = lstatSync(path, { bigint: true });
      if (REPOSITORY_SCAN_EXCLUSIONS.has(entry.name)) {
        continue;
      }
      if (REPOSITORY_SCAN_FILE_EXCLUSIONS.has(entry.name) ||
        REPOSITORY_SCAN_FILE_SUFFIX_EXCLUSIONS.some((suffix) => entry.name.endsWith(suffix))) {
        continue;
      }
      if (stats.dev !== expectedDevice || mountPoints.has(path)) {
        throw new SecurityError("Repository mountpoints are denied in S1", "repository_mountpoint_denied");
      }
      if (stats.isSymbolicLink()) {
        throw new SecurityError("Repository symlinks are denied in S1", "repository_symlink_denied");
      }
      entries.push({
        path: relativePath,
        type: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other",
        device: stats.dev.toString(10),
        inode: stats.ino.toString(10),
        mode: stats.mode.toString(8),
        ownerUid: stats.uid.toString(10),
        ownerGid: stats.gid.toString(10),
        links: stats.nlink.toString(10),
        size: stats.size.toString(10),
        modifiedNanoseconds: stats.mtimeNs.toString(10),
        changedNanoseconds: stats.ctimeNs.toString(10),
      });
      if (entry.name.endsWith(".config.json") && path !== join(root, ROOT_POLICY.configuration.basename)) {
        alternateConfigs.push(relativePath);
      }
      if (stats.isDirectory()) visit(path);
    }
  };
  visit(root);
  if (alternateConfigs.length > 0) {
    throw new SecurityError("Alternate repository configuration documents are denied", "alternate_config_denied");
  }
  return deepFreeze(entries);
}

function openDirectory(path: string, code: string): number {
  try {
    return openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch {
    throw new SecurityError("Directory could not be opened safely", code);
  }
}

function sourceIdentity(stats: BigIntStats): SourceIdentity {
  return {
    device: stats.dev.toString(10),
    inode: stats.ino.toString(10),
    mode: (stats.mode & 0o7777n).toString(8),
    ownerUid: Number(stats.uid),
    ownerGid: Number(stats.gid),
    links: stats.nlink.toString(10),
    size: stats.size.toString(10),
    modifiedNanoseconds: stats.mtimeNs.toString(10),
    changedNanoseconds: stats.ctimeNs.toString(10),
  };
}

function hasProjectRootTraversalSyntax(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const project = (value as Record<string, unknown>).project;
  if (!project || typeof project !== "object" || Array.isArray(project)) return false;
  const root = (project as Record<string, unknown>).root;
  return typeof root === "string" && hasTraversalSegment(root);
}
