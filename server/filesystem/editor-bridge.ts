/**
 * Editor bridge — file reading and editing for the web UI. Provides
 * privacy-safe file viewing (reads files and returns content with size/line
 * info) and transactional file editing (exact preimage match, write, verify).
 *
 * For privacy: only reads within the project root are allowed. File paths
 * are resolved and checked against the project root to prevent traversal.
 */

import {
  statSync,
  existsSync,
  mkdirSync,
  rmSync,
  openSync,
  readSync,
  closeSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { relative, extname, dirname, resolve, join, basename } from "node:path";
import { serverConfig } from "../kernel/config.ts";
import {
  resolveWithinProject,
  assertProjectPathOwnership,
  effectiveProjectRoot,
  type FsGate,
} from "./fs-gate.ts";
import { ValidationError } from "../kernel/errors.ts";
import { readFileText } from "./file-read.ts";
import { webWarn } from "../observability/debug-bridge.ts";
import { movePath } from "../../engine/src/filesystem/move-path.ts";
import { atomicWriteFile } from "../../engine/src/filesystem/atomic-write.ts";
import { getTimelineRecorder } from "../observability/timeline-bridge.ts";
import { sha256 } from "../kernel/digest.ts";
// Raw uniqueness through the canonical owner (effect ids and recycle-dir ids
// stay bare UUIDs — the owner's randomUuid, never a direct node:crypto import).
import { identityOverlapIndex, randomUuid, resolveLocation } from "../kernel/canonical.ts";
import type { RecycledFile } from "../../shared/wire-types.ts";

// After a successful project write, the intelligence map can rebuild.
// Installed at boot by the intelligence bridge — this file never imports
// that bridge (no cycle). Tests that never install a listener are silent.
// `changedPath` is the repo-relative path of the written/created/deleted
// entry: the write KNOWS which file it touched, and the map's incremental
// rebuild uses it as a hint (re-read exactly that file) instead of
// stat-walking the whole tree. Optional so listeners that don't care
// (tests, future consumers) keep the one-argument shape.
type AfterProjectWrite = (projectRoot: string, changedPath?: string) => void;
let afterProjectWrite: AfterProjectWrite | null = null;

/** Wire a listener that runs after a successful create/edit/delete. */
export function installAfterProjectWrite(fn: AfterProjectWrite): void {
  afterProjectWrite = fn;
}

/** Test seam: drop the listener. */
export function clearAfterProjectWrite(): void {
  afterProjectWrite = null;
}

function notifyProjectWrite(projectRoot?: string, changedAbsolutePath?: string): void {
  if (afterProjectWrite === null) return;
  const root = projectRoot ?? serverConfig.projectRoot;
  if (typeof root !== "string" || root.length === 0) return;
  // The abs→relative conversion lives HERE (one owner): every producer
  // knows the absolute path it wrote, and the listener contract stays
  // repo-relative (the shape the map's hint filter expects).
  let changedPath: string | undefined;
  if (typeof changedAbsolutePath === "string" && changedAbsolutePath.length > 0) {
    changedPath = relative(root, changedAbsolutePath);
    if (changedPath.length === 0) changedPath = undefined;
  }
  afterProjectWrite(root, changedPath);
}

// ── Configurables ──
// File read/edit byte limits live in serverConfig.
// Previously inline constants here (1 MiB / 10 MiB) — centralized with an
// env override (HARNESS_WEB_MAX_FILE_READ_BYTES / _EDIT_BYTES).
//
// (filesystem access owner): path-traversal + project-ownership
// are now enforced at the BRIDGE level (the lowest level — the choke
// point) via `server/fs-gate.ts`, NOT in each route. `resolveWithinProject`
// replaces the scattered `isWithinRoot`; `assertProjectPathOwnership`
// (when a `gate` is passed) replaces the route-level `requireProjectByPath`.
// A route that forgets to pass the gate cannot leak — the gate is the
// single owner. `gate` is opt-in: routes pass it for user-supplied paths;
// the tool-executor/run route omit it (ownership done at run-start).

// ── Types ──

export type FileReadResult = Readonly<{
  path: string;
  relativePath: string;
  content: string;
  size: number;
  lineCount: number;
  encoding: string;
  truncated: boolean;
  language: string;
}>;

export type FileEditResult = Readonly<{
  path: string;
  success: boolean;
  oldSize: number;
  newSize: number;
  bytesWritten: number;
}>;

export type FileTreeEntry = Readonly<{
  name: string;
  path: string;
  relativePath: string;
  type: "file" | "directory";
  size: number;
  extension: string | null;
  lineCount: number | null;
}>;

// ── Raw primitives (SPO) ──
// The editor bridge is the SINGLE owner of file read/write/edit/delete
// (SPO). The raw primitives are the LOWEST-LEVEL choke point: they
// enforce the fs-gate (ownership + traversal) once per call, then perform
// the bare filesystem operation. ALL higher-level bridge functions
// (readFile, writeFile, editFile, createFile) delegate to these, and the
// tool-executor's editor tools (readPreimage/writeAtomic) + read_file tool
// also delegate here — so NO code outside this module reads/writes files
// for editing directly (mechanically enforced by editor-bridge-owner.test).

export type FileReadRawResult = Readonly<{
  abs: string;
  content: string;
  size: number;
}>;

export type FileWriteRawResult = Readonly<{
  abs: string;
  bytesWritten: number;
  oldSize: number;
}>;

// ── Helpers ──

function detectLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const langMap: Readonly<Record<string, string>> = {
    ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
    ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".py": "python", ".rs": "rust", ".go": "go", ".java": "java", ".c": "c", ".cpp": "cpp",
    ".h": "c", ".hpp": "cpp", ".cs": "csharp", ".rb": "ruby", ".php": "php",
    ".swift": "swift", ".kt": "kotlin", ".scala": "scala", ".sh": "bash",
    ".json": "json", ".xml": "xml", ".html": "html", ".css": "css", ".scss": "scss",
    ".md": "markdown", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
    ".sql": "sql", ".graphql": "graphql", ".svelte": "svelte", ".vue": "vue",
  };
  return langMap[ext] ?? "text";
}

function countLines(content: string): number {
  return content.split("\n").length;
}

/**
 * Shared gate+resolve — the single choke point for path resolution in the
 * bridge. Enforces project-ownership (whenever a gate is provided) + path-
 * traversal prevention, then returns the absolute path. Used by every
 * public function (raw primitives + higher-level) so every filesystem
 * operation is independently gated. A read-then-write flow (editFile) gates
 * twice (once for the read, once for the write) — each operation is
 * independently verified, which is the correct defense-in-depth posture.
 * The ownership probe is an in-memory SQLite prepared-statement lookup, so
 * the redundant query in a read-then-write flow is negligible.
 *
 * Deny-by-default: when a gate is provided, ownership is ALWAYS enforced
 * against the resolved root — whether the caller passed an explicit
 * `projectRoot` or it fell back to `serverConfig.projectRoot`. A caller
 * that omits `projectRoot` cannot skip the gate; the gate runs against the
 * fallback root, so a user who does not own a project there gets a 403.
 * Without this, omitting `root` skipped ownership entirely, allowing any
 * authenticated user to read/write files in the server's working directory
 * (`process.cwd()`, the default `projectRoot`) without owning a project
 * there — a cross-user filesystem leak.
 */
function resolveAndCheckGate(filePath: string, projectRoot?: string, gate?: FsGate): string {
  // Through the fs-gate owner, not a second `?? serverConfig.projectRoot`:
  // the gate primes exactly this expression, so the string gated here is the
  // string the request resolved.
  const root = effectiveProjectRoot(projectRoot);
  if (gate !== undefined) {
    assertProjectPathOwnership(root, gate);
  }
  return resolveWithinProject(filePath, root);
}

// ── File-effect recording (the ledger's file lane) ──
//
// The bridge is mechanically proven to be the single in-process owner of file
// write/mkdir/delete (`editor-bridge-owner.test.ts`), so recording HERE
// records every such effect the server performs — the editor's saves, the
// file tab's creates and deletes, and every write an agent makes through the
// tool executor's editor tools, which delegate to `writeFileRaw`. Nothing
// upstream has to remember anything, and no call site was changed to get it.
//
// Before this, `recordFileEffect` had zero production callers: the ledger held
// tool calls but could not say what those calls did to the user's code.
//
// KNOWN GAP: the proof covers writes made through Node's fs API in this
// process. Writes performed by a SUBPROCESS — `auto-check-runner`'s spawned
// commands, anything the `execute_command` tool runs — do not pass through
// here and are still unrecorded. That needs a different mechanism (a
// git-status diff around the subprocess, or a guarded command port); it is not
// something this choke point can see.

/**
 * The digest of NO BYTES.
 *
 * Used where the true content is empty: the preimage of a file that did not
 * exist, the postimage of a deletion, and both sides of a mkdir (a directory
 * has no content). It is the real digest of the real (empty) byte sequence,
 * not a placeholder standing in for a value we failed to compute — a
 * fabricated digest would make the ledger confidently wrong, which is worse
 * than an empty one.
 */
const EMPTY_CONTENT_DIGEST = sha256("");

type FileEffectRecord = Readonly<{
  path: string;
  operation: "write" | "delete" | "mkdir";
  preimageDigest: string;
  postimageDigest: string;
  /** The bytes replaced, when they are small enough to keep. */
  preimageContent?: string;
}>;

/**
 * Record one file effect in the timeline ledger.
 *
 * Correlation is deliberately EMPTY: the recorder merges the ambient recording
 * context (entered once, in the router), so the run/turn/agent this write
 * belongs to comes from the call structure. Passing anything here would either
 * duplicate that or invent it.
 *
 * A recorder failure is reported through the debug bridge and does NOT fail
 * the caller. The operation has already completed on disk at this point, so
 * throwing would report a failure that did not happen and could drive a retry
 * against a file that has already changed. The gap is surfaced rather than
 * swallowed. Recording the effect BEFORE the operation (an intent/terminal
 * pair via `beginEffect`/`endEffect`) is the stronger shape and is the natural
 * next step; it is a larger change than wiring the existing recorder.
 */
function recordFileEffect(effect: FileEffectRecord): void {
  try {
    getTimelineRecorder().recordFileEffect({
      effectId: randomUuid(),
      path: effect.path,
      operation: effect.operation,
      preimageDigest: effect.preimageDigest,
      postimageDigest: effect.postimageDigest,
      description: `${effect.operation} ${effect.path}`,
      correlation: {},
      ...(effect.preimageContent !== undefined ? { preimageContent: effect.preimageContent } : {}),
    });
  } catch (err) {
    webWarn("editor-bridge", "file effect not recorded", () => ({
      path: effect.path,
      operation: effect.operation,
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}

/**
 * The content a file holds right now, or `null` when there is nothing to read.
 *
 * Returns `null` rather than `""` for an unreadable file so the caller cannot
 * mistake "could not read it" for "it was empty" and record a digest that
 * claims the file had no content. A binary or locked file therefore yields an
 * effect with the empty digest and NO preimage document, which is a smaller
 * claim than a wrong one.
 */
function preimageOf(abs: string): string | null {
  if (!existsSync(abs)) return null;
  try {
    if (!statSync(abs).isFile()) return null;
    return readFileText(abs);
  } catch (err) {
    webWarn("editor-bridge", "preimage unreadable; effect recorded without it", () => ({
      path: abs, error: err instanceof Error ? err.message : String(err),
    }));
    return null;
  }
}

/**
 * The preimage fields for an effect, keeping the replaced bytes only when they
 * fit inside the editor's own content bound. A larger preimage is still
 * DIGESTED (so the ledger can prove what was there) but is not copied into the
 * ledger wholesale.
 */
function preimageFields(content: string | null): Readonly<{ preimageDigest: string; preimageContent?: string }> {
  if (content === null) return { preimageDigest: EMPTY_CONTENT_DIGEST };
  const digest = sha256(content);
  if (content.length > serverConfig.maxFileEditBytes) return { preimageDigest: digest };
  return { preimageDigest: digest, preimageContent: content };
}

// ── Raw primitives (the lowest-level public read/write) ──

// ── Probing a file BEFORE reading it (the honest-state primitive) ─────────
//
// A surface that opens files has to answer three questions before it decodes
// anything: does this path hold a file at all, how big is it, and are these
// bytes text? Answering them by READING the file is what produces the two
// dishonest states this bridge previously had no way to avoid — a binary file
// decoded as UTF-8 and rendered as mojibake, and a 40MB file pulled into
// memory to discover it was too big to show.
//
// So the probe reads a bounded HEAD of the file (never the whole thing) and
// classifies it. It performs no mutation, so it records no effect.

/**
 * How many bytes of a file's head decide whether it is text.
 *
 * Written as a shift, the way this codebase writes byte sizes
 * (`server/config.ts` declares its file caps as `1 << 20`), because it is a
 * SIZE and not an operator knob: it is the sniff window the UTF-8 test runs
 * over, and no deployment has a reason to want a different one. Anything an
 * operator can legitimately tune lives in `server/config.ts`.
 */
const BINARY_SNIFF_BYTES = 8 << 10; // 8 KiB

export type FileProbeResult = Readonly<{
  abs: string;
  relativePath: string;
  /** What is at the path. `absent` when nothing is. */
  kind: "file" | "directory" | "absent";
  size: number;
  /** Whether the bytes are text (only meaningful for `kind: "file"`). */
  text: boolean;
  /** Why the bytes are not text, in plain words — null when they are. */
  binaryReason: string | null;
  /** An image media type when the extension declares one, else null. */
  mediaType: string | null;
  language: string;
  /** The read cap this server is configured with, so a caller can SAY it. */
  maxReadBytes: number;
  /** The write cap, for the same reason. */
  maxEditBytes: number;
}>;

/**
 * Image media types this server will hand back as bytes, by extension.
 *
 * An ALLOWLIST, not a sniff: the type is declared from the name the user
 * already sees, so a file cannot talk the server into serving it as something
 * else. Anything absent from this table is simply not an image as far as this
 * bridge is concerned, which is the honest answer for a format we cannot claim
 * to render.
 */
const IMAGE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

/** The declared image media type for a path, or null when it is not one. */
export function imageMediaType(filePath: string): string | null {
  return IMAGE_MEDIA_TYPES[extname(filePath).toLowerCase()] ?? null;
}

/**
 * Whether a byte head is text. Two tests, in order of cost:
 *   1. a NUL byte never appears in UTF-8 text;
 *   2. the head must decode as UTF-8 in FATAL mode.
 *
 * The second is what catches the files the first misses (Latin-1 text, most
 * compiled objects). The head is decoded rather than the whole file so a large
 * binary costs 8KB to classify. A multi-byte character straddling the 8KB
 * boundary would decode as truncated input, so the last few bytes are dropped
 * before the fatal decode — a false "binary" on a large text file would be a
 * worse answer than a slightly shorter sniff.
 */
function classifyBytes(head: Buffer, complete: boolean): Readonly<{ text: boolean; reason: string | null }> {
  if (head.includes(0)) {
    return { text: false, reason: "these bytes contain a zero byte, which text never does" };
  }
  // A UTF-8 sequence is at most 4 bytes, so trimming 3 from a partial head
  // cannot cut a character in two.
  const decodable = complete ? head : head.subarray(0, Math.max(0, head.length - 3));
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(decodable);
    return { text: true, reason: null };
  } catch {
    return { text: false, reason: "these bytes are not valid UTF-8 text" };
  }
}

/**
 * What is at `filePath`, without decoding it. Enforces the fs-gate at the
 * same choke point every other bridge function uses.
 */
export function probeFile(filePath: string, projectRoot?: string, gate?: FsGate): FileProbeResult {
  const abs = resolveAndCheckGate(filePath, projectRoot, gate);
  const root = projectRoot ?? serverConfig.projectRoot;
  const base = {
    abs,
    relativePath: relative(root, abs),
    language: detectLanguage(abs),
    mediaType: imageMediaType(abs),
    maxReadBytes: serverConfig.maxFileReadBytes,
    maxEditBytes: serverConfig.maxFileEditBytes,
  };
  if (!existsSync(abs)) {
    return { ...base, kind: "absent", size: 0, text: false, binaryReason: null };
  }
  const st = statSync(abs);
  if (st.isDirectory()) {
    return { ...base, kind: "directory", size: st.size, text: false, binaryReason: null };
  }
  if (!st.isFile()) {
    return {
      ...base,
      kind: "absent",
      size: 0,
      text: false,
      binaryReason: "this path is not a regular file",
    };
  }
  if (st.size === 0) {
    // An empty file is text: there is nothing in it that is not.
    return { ...base, kind: "file", size: 0, text: true, binaryReason: null };
  }
  const fd = openSync(abs, "r");
  try {
    const head = Buffer.alloc(Math.min(BINARY_SNIFF_BYTES, st.size));
    const read = readSync(fd, head, 0, head.length, 0);
    const { text, reason } = classifyBytes(head.subarray(0, read), read >= st.size);
    return { ...base, kind: "file", size: st.size, text, binaryReason: reason };
  } finally {
    closeSync(fd);
  }
}

/**
 * A file's raw BYTES (not text). Used to serve an image to a viewer that can
 * actually show it, instead of decoding it into a string it is not.
 *
 * `maxBytes` is checked against the stat BEFORE the read, so an oversized file
 * is refused rather than loaded to find out.
 */
export function readFileBytes(
  filePath: string,
  maxBytes: number,
  projectRoot?: string,
  gate?: FsGate,
): Readonly<{ abs: string; bytes: Buffer; size: number }> {
  const abs = resolveAndCheckGate(filePath, projectRoot, gate);
  if (!existsSync(abs)) {
    throw new ValidationError(`File not found: ${filePath}`, "file_not_found");
  }
  const st = statSync(abs);
  if (!st.isFile()) {
    throw new ValidationError(`Not a file: ${filePath}`, "not_a_file");
  }
  if (st.size > maxBytes) {
    throw new ValidationError(
      `File too large (${st.size} bytes). Max ${Math.round(maxBytes / 1024)}KB.`,
      "file_too_large",
    );
  }
  // A BINARY read: no encoding argument, so this returns a Buffer. The
  // text-read owner (server/file-read.ts) decides the ENCODING of text reads
  // and has nothing to decide here — there is none.
  return { abs, bytes: readFileSync(abs), size: st.size };
}

/**
 * Read a file's raw content. Enforces fs-gate (ownership + traversal) at
 * the choke point. No truncation, no UI metadata — returns the full
 * content + size. When `maxBytes` is provided, rejects (file_too_large)
 * BEFORE reading the content into memory (prevents OOM on huge files).
 * Used by the tool-executor's `read_file` tool (with maxBytes) and the
 * editor tools' preimage read (without maxBytes — needs full content for
 * hash verification). Throws typed ValidationError on missing/not-a-file.
 */
export function readFileRaw(
  filePath: string,
  projectRoot?: string,
  gate?: FsGate,
  maxBytes?: number,
): FileReadRawResult {
  const abs = resolveAndCheckGate(filePath, projectRoot, gate);
  if (!existsSync(abs)) {
    throw new ValidationError(`File not found: ${filePath}`, "file_not_found");
  }
  const st = statSync(abs);
  if (!st.isFile()) {
    throw new ValidationError(`Not a file: ${filePath}`, "not_a_file");
  }
  if (maxBytes !== undefined && st.size > maxBytes) {
    throw new ValidationError(
      `File too large (${st.size} bytes). Max ${Math.round(maxBytes / 1024)}KB.`,
      "file_too_large",
    );
  }
  const content = readFileText(abs);
  return { abs, content, size: st.size };
}

/**
 * Write content to a file. Enforces fs-gate (ownership + traversal) at the
 * choke point. No UI size-limit check — the caller enforces its own bounds
 * (the route checks maxFileEditBytes; the tool-executor checks
 * toolMaxFileBytes upstream). Returns the absolute path + old size (for
 * delta reporting). Used by the tool-executor's `writeAtomic` (editor
 * tools) so ALL file writes go through the editor bridge (SPO).
 */
export function writeFileRaw(
  filePath: string,
  content: string,
  projectRoot?: string,
  gate?: FsGate,
): FileWriteRawResult {
  const abs = resolveAndCheckGate(filePath, projectRoot, gate);
  // One stat that answers absence: never exists-then-stat (a file removed between the two threw ENOENT).
  const oldSize = statSync(abs, { throwIfNoEntry: false })?.size ?? 0;
  // Captured BEFORE the write, because after it the bytes being replaced no
  // longer exist anywhere. This is what makes the recorded effect reversible
  // rather than merely observable.
  const preimage = preimageOf(abs);
  // Atomic write: write to a sibling temp file, then rename. A crash
  // mid-write never leaves the target truncated/corrupted — the temp file
  // is the only thing in an inconsistent state, and it is cleaned up. The
  // rename is atomic on POSIX (and same-filesystem on Windows). The temp
  // file lives in the same directory so the rename is a same-filesystem
  // move (no cross-device rename error). This is the fix for the
  // `writeAtomic` function in tool-executor that delegated here but was
  // NOT actually atomic (a plain writeFileSync leaves a partial file on a
  // crash, corrupting the user's source).
  // THE SHARED OWNER, not a second copy of the same two calls. The pair that
  // used to be here dropped the target's permissions on every edit — a 0600
  // file came back 0664 — which is the identical defect the config writer had
  // already found and fixed one file away. The one owner is the engine's
  // (`engine/src/filesystem/atomic-write.ts`, which also asks the checkout
  // write door); a new user file is created as a plain write would create it
  // (0o666 before the umask), and a missing directory is not created here.
  // A project file that is a symbolic link is written THROUGH only when the
  // link resolves inside the project (the writer's one link rule); a link
  // out of it is refused, never replaced by a regular file.
  const written = atomicWriteFile(abs, content, { createMode: 0o666, createParentDirectories: false, linkTargetRoots: [effectiveProjectRoot(projectRoot)] });
  if (!written.success) throw written.error;
  recordFileEffect({
    path: abs,
    operation: "write",
    ...preimageFields(preimage),
    postimageDigest: sha256(content),
  });
  notifyProjectWrite(projectRoot, abs);
  return { abs, bytesWritten: content.length, oldSize };
}

// ── Public API ──

export function readFile(filePath: string, projectRoot?: string, gate?: FsGate): FileReadResult {
  const { abs, content, size } = readFileRaw(filePath, projectRoot, gate);
  const root = projectRoot ?? serverConfig.projectRoot;
  const truncated = size > serverConfig.maxFileReadBytes;
  const truncatedContent = content.slice(0, serverConfig.maxFileReadBytes);
  return {
    path: abs,
    relativePath: relative(root, abs),
    content: truncatedContent,
    size,
    lineCount: countLines(truncatedContent),
    encoding: "utf-8",
    truncated,
    language: detectLanguage(abs),
  };
}

export function writeFile(filePath: string, content: string, projectRoot?: string, gate?: FsGate): FileEditResult {
  if (content.length > serverConfig.maxFileEditBytes) {
    throw new ValidationError("File content exceeds maximum size", "file_too_large");
  }
  const { abs, bytesWritten, oldSize } = writeFileRaw(filePath, content, projectRoot, gate);
  const newSize = statSync(abs).size;
  return {
    path: abs,
    success: true,
    oldSize,
    newSize,
    bytesWritten,
  };
}

export function editFile(
  filePath: string,
  oldContent: string,
  newContent: string,
  projectRoot?: string,
  gate?: FsGate,
): FileEditResult {
  // "no preimage" and "an EMPTY preimage" are different states, and only the
  // first is an error. This used to reject `oldContent === ""` outright, which
  // forced every caller holding an empty file to reach for the UNCHECKED
  // `writeFile` instead — so saving a file that was empty when it was opened
  // skipped the stale-write check entirely and silently overwrote whatever had
  // been written to it since. Absence is already caught one line above:
  // `readFileRaw` throws `file_not_found` when there is no file to edit, so a
  // "new file" cannot reach here at all and needs no separate rejection.
  const { abs, content: current } = readFileRaw(filePath, projectRoot, gate);
  if (current !== oldContent) {
    // Covers the empty case in BOTH directions: an empty preimage against a
    // file that has since gained content, and a stale non-empty preimage
    // against a file that has since been emptied.
    throw new ValidationError("File content has changed (preimage mismatch)", "preimage_mismatch");
  }
  // `current === oldContent` is established above, so this is always a
  // whole-content replacement. Use a FUNCTION replacement so `$`-special
  // patterns in `newContent` ($&, $', $n) are NOT expanded — a string
  // replacement would insert the matched text / capture groups where the user
  // literally wrote `$&`, corrupting file content that contains `$`-patterns
  // (regex, shell vars, dollar signs). The function receives the match +
  // groups but ignores them, returning `newContent` verbatim.
  const updated = current.replace(oldContent, () => newContent);
  if (updated === current) {
    throw new ValidationError("Replacement had no effect (oldContent not found)", "no_change");
  }
  const { bytesWritten } = writeFileRaw(abs, updated, projectRoot, gate);
  return {
    path: abs,
    success: true,
    oldSize: oldContent.length,
    newSize: updated.length,
    bytesWritten,
  };
}

// ── File/folder creation + deletion (file tab view/edit/add/remove) ──
// The file tab IS a file manager, so creating/deleting real files is the
// intent. All paths are confined to the project root (traversal
// guard) so a crafted path cannot escape.

export type FileCreateResult = Readonly<{
  path: string;
  relativePath: string;
  type: "file" | "directory";
}>;

/**
 * Create a new file (empty or with content) at `filePath`. Rejects if the
 * path escapes the root or a file already exists at that path (prevents
 * accidentally overwriting an existing file via "add file").
 */
export function createFile(filePath: string, content: string, projectRoot?: string, gate?: FsGate): FileCreateResult {
  const abs = resolveAndCheckGate(filePath, projectRoot, gate);
  if (existsSync(abs)) {
    throw new ValidationError(`A file or folder already exists at ${filePath}`, "already_exists");
  }
  const parentDir = dirname(abs);
  if (!existsSync(parentDir)) {
    throw new ValidationError(`Parent directory does not exist: ${dirname(filePath)}. Create the directory first.`, "parent_not_found");
  }
  // Atomic write (writeFileRaw writes to a temp file + renames) so a
  // crash mid-create never leaves a partial file at the target path.
  writeFileRaw(abs, content, projectRoot, gate);
  const root = projectRoot ?? serverConfig.projectRoot;
  return { path: abs, relativePath: relative(root, abs), type: "file" };
}

/**
 * Create a new directory at `dirPath`. Non-recursive — the parent
 * directory must already exist (the file tree creates folders under a
 * selected directory, one level at a time). Rejects if the path escapes
 * the root or already exists.
 */
export function createDirectory(dirPath: string, projectRoot?: string, gate?: FsGate): FileCreateResult {
  const abs = resolveAndCheckGate(dirPath, projectRoot, gate);
  if (existsSync(abs)) {
    throw new ValidationError(`A file or folder already exists at ${dirPath}`, "already_exists");
  }
  const parentDir = dirname(abs);
  if (!existsSync(parentDir)) {
    throw new ValidationError(`Parent directory does not exist: ${dirname(dirPath)}. Create the parent directory first.`, "parent_not_found");
  }
  mkdirSync(abs, { recursive: false });
  // A directory has no content on either side, so both digests are the digest
  // of no bytes — a true statement about a directory, not a stand-in.
  recordFileEffect({
    path: abs,
    operation: "mkdir",
    preimageDigest: EMPTY_CONTENT_DIGEST,
    postimageDigest: EMPTY_CONTENT_DIGEST,
  });
  const root = projectRoot ?? serverConfig.projectRoot;
  notifyProjectWrite(projectRoot, abs);
  return { path: abs, relativePath: relative(root, abs), type: "directory" };
}

export type FileDeleteResult = Readonly<{
  path: string;
  relativePath: string;
  removed: boolean;
  wasDirectory: boolean;
  recycleId: string;
}>;

export type { RecycledFile } from "../../shared/wire-types.ts";

export type FileRestoreResult = Readonly<{
  path: string;
  relativePath: string;
  wasDirectory: boolean;
  recycleId: string;
}>;

const RECYCLE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Harness recycle — sibling of the DB, derived, not a second configurable. */
function recycleRoot(): string {
  return join(dirname(resolve(serverConfig.dbPath)), "recycle");
}

function readRecycleMeta(id: string): RecycledFile {
  if (!RECYCLE_ID_RE.test(id)) {
    throw new ValidationError("That recycle id is not a recycle entry", "invalid_recycle_id");
  }
  const metaPath = join(recycleRoot(), id, "meta.json");
  if (!existsSync(metaPath)) {
    throw new ValidationError("That recycle entry is gone", "recycle_not_found");
  }
  const raw: unknown = JSON.parse(readFileText(metaPath));
  if (raw === null || typeof raw !== "object") {
    throw new ValidationError("That recycle entry is unreadable", "recycle_corrupt");
  }
  const rec = raw as Record<string, unknown>;
  if (
    typeof rec["id"] !== "string" ||
    typeof rec["name"] !== "string" ||
    typeof rec["originalPath"] !== "string" ||
    typeof rec["relativePath"] !== "string" ||
    typeof rec["projectRoot"] !== "string" ||
    typeof rec["wasDirectory"] !== "boolean" ||
    typeof rec["deletedAt"] !== "number"
  ) {
    throw new ValidationError("That recycle entry is unreadable", "recycle_corrupt");
  }
  return {
    id: rec["id"],
    name: rec["name"],
    originalPath: rec["originalPath"],
    relativePath: rec["relativePath"],
    projectRoot: rec["projectRoot"],
    wasDirectory: rec["wasDirectory"],
    deletedAt: rec["deletedAt"],
  };
}

/**
 * Delete a file or directory at `filePath` by MOVING it to the harness
 * recycle bin. Restore puts the bytes back. Rejects if the path escapes
 * the root, is the project root, or does not exist.
 */
export function deleteFile(filePath: string, projectRoot?: string, gate?: FsGate): FileDeleteResult {
  const root = resolve(projectRoot ?? serverConfig.projectRoot);
  const abs = resolveAndCheckGate(filePath, projectRoot, gate);
  // The root itself (or anything holding it), by identity — never a spelling.
  if (identityOverlapIndex().atOrUnder(resolveLocation(root, "the project root"), resolveLocation(abs, "the file to delete"))) {
    throw new ValidationError(
      "Refusing to delete the project root. This action deletes individual files/folders, not the whole project (delete the project from the sidebar instead).",
      "cannot_delete_root",
    );
  }
  if (!existsSync(abs)) {
    throw new ValidationError(`File not found: ${filePath}`, "file_not_found");
  }
  const st = statSync(abs);
  const wasDirectory = st.isDirectory();
  const preimage = preimageOf(abs);
  const id = randomUuid();
  const dest = join(recycleRoot(), id);
  mkdirSync(dest, { recursive: true });
  const payload = join(dest, "payload");
  const meta: RecycledFile = {
    id,
    name: basename(abs),
    originalPath: abs,
    relativePath: relative(root, abs),
    projectRoot: root,
    wasDirectory,
    deletedAt: Date.now(),
  };
  writeFileSync(join(dest, "meta.json"), `${JSON.stringify(meta)}\n`, "utf8");
  mkdirSync(dirname(payload), { recursive: true });
  try {
    movePath(abs, payload);
  } catch (err) {
    if (err instanceof ValidationError && err.code === "move_did_not_land") {
      throw new ValidationError("Recycle copy did not land — original left in place", "recycle_copy_failed");
    }
    throw err;
  }
  recordFileEffect({
    path: abs,
    operation: "delete",
    ...preimageFields(preimage),
    postimageDigest: EMPTY_CONTENT_DIGEST,
  });
  notifyProjectWrite(projectRoot, abs);
  return { path: abs, relativePath: meta.relativePath, removed: true, wasDirectory, recycleId: id };
}

/** Every recycle entry the harness still holds. The route filters by owner. */
export function listRecycledFiles(): readonly RecycledFile[] {
  const root = recycleRoot();
  if (!existsSync(root)) return [];
  const out: RecycledFile[] = [];
  for (const name of readdirSync(root)) {
    if (!RECYCLE_ID_RE.test(name)) continue;
    try {
      out.push(readRecycleMeta(name));
    } catch (err) {
      // A corrupt slot is not a listed file — skip, never invent. Only the
      // "this slot is not a good entry" answers are absorbed: a gone/corrupt
      // record, an unparseable one, or a slot a concurrent restore removed
      // between the readdir and the read. Anything else (I/O faults,
      // permission errors) is a real problem the caller must hear about.
      const skippable =
        err instanceof SyntaxError ||
        (err instanceof ValidationError &&
          (err.code === "recycle_corrupt" || err.code === "recycle_not_found")) ||
        (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT");
      if (!skippable) throw err;
    }
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt);
}

/**
 * Restore a recycled file to its original path. Refuses if that path is
 * occupied. Gates the destination as a project write.
 */
export function restoreFile(recycleId: string, gate?: FsGate): FileRestoreResult {
  const meta = readRecycleMeta(recycleId);
  const payload = join(recycleRoot(), recycleId, "payload");
  if (!existsSync(payload)) {
    throw new ValidationError("That recycle entry has no file to restore", "recycle_not_found");
  }
  const dest = resolveAndCheckGate(meta.originalPath, meta.projectRoot, gate);
  if (existsSync(dest)) {
    throw new ValidationError(
      `Something already lives at ${meta.relativePath} — restore refused rather than overwrite`,
      "restore_occupied",
    );
  }
  mkdirSync(dirname(dest), { recursive: true });
  try {
    movePath(payload, dest);
  } catch (err) {
    if (err instanceof ValidationError && err.code === "move_did_not_land") {
      throw new ValidationError("Restore copy did not land — recycle left in place", "recycle_copy_failed");
    }
    throw err;
  }
  rmSync(join(recycleRoot(), recycleId), { recursive: true });
  const restored = preimageOf(dest);
  recordFileEffect({
    path: dest,
    operation: meta.wasDirectory ? "mkdir" : "write",
    preimageDigest: EMPTY_CONTENT_DIGEST,
    postimageDigest: restored === null ? EMPTY_CONTENT_DIGEST : sha256(restored),
  });
  notifyProjectWrite(meta.projectRoot, dest);
  return {
    path: dest,
    relativePath: meta.relativePath,
    wasDirectory: meta.wasDirectory,
    recycleId,
  };
}
