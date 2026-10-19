import { type ArchitectureEffect } from "../../src/architecture-manifest.ts";
import { ARCHITECTURE_SOURCE_EXTENSIONS } from "../../src/shared/source-extensions.ts";

export type FilesystemEffect = Extract<ArchitectureEffect, "filesystem-read" | "filesystem-write">;
export type FilesystemOpenMode = "read" | "read-write" | "unknown" | "write";
export type GitInvocationClassification = "git" | "modeled-non-git" | "unmodeled";

const DEPENDENCY_EFFECTS: ReadonlyMap<string, readonly ArchitectureEffect[]> = new Map([
  ["child_process", ["child-process"]],
  ["node:child_process", ["child-process"]],
  ["crypto", ["cryptography"]],
  ["node:crypto", ["cryptography"]],
  ["net", ["network"]],
  ["node:net", ["network"]],
  ["sqlite", ["filesystem-read", "filesystem-write"]],
  ["node:sqlite", ["filesystem-read", "filesystem-write"]],
  ["better-sqlite3", ["filesystem-read", "filesystem-write"]],
  ["/tmp/s3-sqlite-adapter-benchmark/node_modules/better-sqlite3", [
    "filesystem-read", "filesystem-write",
  ]],
] as const);

const FILESYSTEM_READ_APIS = new Set([
  "access", "accessSync", "createReadStream", "exists", "existsSync", "fstat", "fstatSync", "glob",
  "globSync", "lstat", "lstatSync", "opendir", "opendirSync", "read", "readdir", "readdirSync",
  "readFile", "readFileSync", "readlink", "readlinkSync", "readSync", "readv", "readvSync", "realpath",
  "realpathSync", "stat", "statfs", "statfsSync", "statSync", "watch", "watchFile",
]);

export const FILESYSTEM_WRITE_APIS = new Set([
  "appendFile", "appendFileSync", "chmod", "chmodSync", "chown", "chownSync", "copyFile",
  "copyFileSync", "cp", "cpSync", "createWriteStream", "fchmod", "fchmodSync", "fchown", "fchownSync",
  "fdatasync", "fdatasyncSync", "fsync", "fsyncSync", "ftruncate", "ftruncateSync", "futimes",
  "futimesSync", "lchmod", "lchmodSync", "lchown", "lchownSync", "link", "linkSync", "lutimes",
  "lutimesSync", "mkdir", "mkdirSync", "mkdtemp", "mkdtempSync", "rename", "renameSync", "rm",
  "rmSync", "rmdir", "rmdirSync", "symlink", "symlinkSync", "truncate", "truncateSync", "unlink",
  "unlinkSync", "utimes", "utimesSync", "write", "writeFile", "writeFileSync", "writeSync", "writev",
  "writevSync",
]);

const FILESYSTEM_OPEN_APIS = new Set(["open", "openSync"]);
const FILESYSTEM_MODELED_NON_EFFECT_APIS = new Set([
  "close", "closeSync", "constants", "Dir", "Dirent", "FileHandle", "ReadStream", "Stats", "StatFs",
  "WriteStream", "promises",
]);
export const FILESYSTEM_WRITE_FLAG_NAMES = new Set([
  "O_APPEND", "O_CREAT", "O_EXCL", "O_TMPFILE", "O_TRUNC", "O_WRONLY",
]);
const FILESYSTEM_AUXILIARY_FLAG_NAMES = new Set([
  "O_CLOEXEC", "O_DIRECT", "O_DIRECTORY", "O_DSYNC", "O_NOATIME", "O_NOCTTY", "O_NOFOLLOW",
  "O_NONBLOCK", "O_PATH", "O_SYNC",
]);

const AMBIENT_FORBIDDEN_EFFECT_IDENTIFIERS = new Set([
  "abort", "chdir", "dlopen", "eval", "execve", "fetch", "Function", "kill", "loadEnvFile", "setgid",
  "setuid", "umask", "WebSocket", "Worker", "XMLHttpRequest",
]);

const RUNTIME_EXECUTION_APIS = new Set([
  "exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync",
]);
const UNQUALIFIED_RUNTIME_EXECUTION_SINKS = new Set([
  "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync",
]);
const AMBIGUOUS_UNQUALIFIED_FILESYSTEM_APIS = new Set([
  "write", "writeSync", "writev", "writevSync",
]);

const STATIC_ARGUMENT_SINKS: ReadonlyMap<string, readonly number[]> = new Map<string, readonly number[]>([
  ...[
    "exec", "execFile", "execFileSync", "execSync", "lstat", "lstatSync", "mkdir", "mkdirSync", "open",
    "openSync", "prepare", "query", "readFile", "readFileSync", "readlink", "readlinkSync", "realpath",
    "realpathSync", "rm", "rmSync", "rmdir", "rmdirSync", "run", "spawn", "spawnSync", "stat",
    "statSync", "stringify", "truncate", "truncateSync", "unlink", "unlinkSync", "writeFile",
    "writeFileSync", "appendFile", "appendFileSync",
  ].map((name) => [name, [0] as const] as const),
  ...[
    "copyFile", "copyFileSync", "cp", "cpSync", "rename", "renameSync", "symlink", "symlinkSync",
  ].map((name) => [name, [0, 1] as const] as const),
]);

const FORBIDDEN_EFFECT_IDENTIFIERS = new Set([
  ...[...FILESYSTEM_WRITE_APIS].filter((name) => !AMBIGUOUS_UNQUALIFIED_FILESYSTEM_APIS.has(name)),
  ...FILESYSTEM_WRITE_FLAG_NAMES,
  "O_RDWR",
  ...AMBIENT_FORBIDDEN_EFFECT_IDENTIFIERS,
]);

export function isSupportedJavaScriptSourcePath(path: string): boolean {
  return ARCHITECTURE_SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

export function dependencyEffects(specifier: string): readonly ArchitectureEffect[] {
  return DEPENDENCY_EFFECTS.get(specifier) ?? [];
}

export function isForbiddenEffectSurfaceIdentifier(identifier: string): boolean {
  return FORBIDDEN_EFFECT_IDENTIFIERS.has(identifier);
}

export function isFilesystemModuleSpecifier(specifier: string): boolean {
  return ["fs", "fs/promises", "node:fs", "node:fs/promises"].includes(specifier);
}

export function canonicalFilesystemModuleSpecifier(specifier: string): "node:fs" | "node:fs/promises" | undefined {
  if (specifier === "fs" || specifier === "node:fs") return "node:fs";
  if (specifier === "fs/promises" || specifier === "node:fs/promises") return "node:fs/promises";
  return undefined;
}

export function classifyFilesystemApi(
  name: string,
  openMode?: FilesystemOpenMode,
): Readonly<{ effects: readonly FilesystemEffect[]; modeled: boolean }> {
  if (FILESYSTEM_READ_APIS.has(name)) return { effects: ["filesystem-read"], modeled: true };
  if (FILESYSTEM_WRITE_APIS.has(name)) return { effects: ["filesystem-write"], modeled: true };
  if (FILESYSTEM_MODELED_NON_EFFECT_APIS.has(name)) return { effects: [], modeled: true };
  if (!FILESYSTEM_OPEN_APIS.has(name)) return { effects: [], modeled: false };
  if (openMode === "read") return { effects: ["filesystem-read"], modeled: true };
  if (openMode === "write") return { effects: ["filesystem-write"], modeled: true };
  if (openMode === "read-write") {
    return { effects: ["filesystem-read", "filesystem-write"], modeled: true };
  }
  return { effects: ["filesystem-read", "filesystem-write"], modeled: false };
}

export function classifyFilesystemOpenFlagTokens(tokens: readonly (number | string)[]): FilesystemOpenMode {
  let read = false;
  let write = false;
  let recognizedAccess = false;
  for (const token of tokens) {
    if (typeof token === "number") {
      if (token === 0) {
        read = true;
        recognizedAccess = true;
      } else {
        return "unknown";
      }
      continue;
    }
    if (token === "O_RDONLY") {
      read = true;
      recognizedAccess = true;
      continue;
    }
    if (token === "O_RDWR") {
      read = true;
      write = true;
      recognizedAccess = true;
      continue;
    }
    if (FILESYSTEM_WRITE_FLAG_NAMES.has(token)) {
      write = true;
      recognizedAccess = true;
      continue;
    }
    if (FILESYSTEM_AUXILIARY_FLAG_NAMES.has(token)) continue;
    const normalized = token.toLocaleLowerCase("en-US");
    if (/^(?:r|rs|sr)$/u.test(normalized)) {
      read = true;
      recognizedAccess = true;
      continue;
    }
    if (/^(?:r\+|rs\+|sr\+)$/u.test(normalized)) {
      read = true;
      write = true;
      recognizedAccess = true;
      continue;
    }
    if (/^(?:a|ax|as|w|wx|x)$/u.test(normalized)) {
      write = true;
      recognizedAccess = true;
      continue;
    }
    if (/^(?:a|ax|as|w|wx|x)\+$/u.test(normalized)) {
      read = true;
      write = true;
      recognizedAccess = true;
      continue;
    }
    return "unknown";
  }
  if (!recognizedAccess) return "unknown";
  return read && write ? "read-write" : write ? "write" : "read";
}

export function isRuntimeExecutionApi(name: string): boolean {
  return RUNTIME_EXECUTION_APIS.has(name);
}

export function isUnqualifiedRuntimeExecutionSink(name: string): boolean {
  return UNQUALIFIED_RUNTIME_EXECUTION_SINKS.has(name);
}

export function governedStaticArgumentIndexes(name: string): readonly number[] | undefined {
  return STATIC_ARGUMENT_SINKS.get(name);
}

export function isGitExecutable(value: string): boolean {
  const normalized = value.trim();
  return normalized === "git" || /(?:^|\/)git$/u.test(normalized);
}

export function isGitProcessInvocation(executable: string, argumentsList: readonly string[]): boolean {
  return classifyProcessInvocation(executable, argumentsList) === "git";
}

export function isGitShellCommand(value: string): boolean {
  return classifyShellCommand(value) === "git";
}

export function classifyProcessInvocation(
  executable: string,
  argumentsList: readonly string[],
): GitInvocationClassification {
  if (isGitExecutable(executable)) return "git";
  if (isEnvironmentExecutable(executable)) {
    const command = environmentCommand(argumentsList);
    if (command.classification !== "command") return command.classification;
    return classifyExecutableAndArguments(command.executable, command.argumentsList);
  }
  return classifyExecutableAndArguments(executable, argumentsList);
}

export function classifyShellCommand(value: string): GitInvocationClassification {
  const words = simpleShellWords(value);
  if (words.length === 0) return "unmodeled";
  if (words.some(isShellControlWord)) {
    return words.some(isGitExecutable) ? "git" : "unmodeled";
  }
  let commandIndex = 0;
  while (commandIndex < words.length && isEnvironmentAssignment(words[commandIndex]!)) commandIndex += 1;
  const executable = words[commandIndex];
  if (executable === undefined) return "unmodeled";
  return classifyProcessInvocation(executable, words.slice(commandIndex + 1));
}

export function isEnvironmentExecutable(value: string): boolean {
  const normalized = value.trim();
  return normalized === "env" || /(?:^|\/)env$/u.test(normalized);
}

function environmentCommand(argumentsList: readonly string[]): Readonly<{
  classification: "command";
  executable: string;
  argumentsList: readonly string[];
}> | Readonly<{ classification: "modeled-non-git" | "unmodeled" }> {
  let index = 0;
  while (index < argumentsList.length) {
    const argument = argumentsList[index]!;
    if (argument === "--") {
      index += 1;
      break;
    }
    if (isEnvironmentAssignment(argument)) {
      index += 1;
      continue;
    }
    if (["-i", "--ignore-environment", "-0", "--null"].includes(argument)) {
      index += 1;
      continue;
    }
    if (argument === "-S" || argument === "--split-string" || argument.startsWith("-S") ||
      argument.startsWith("--split-string=")) return { classification: "unmodeled" };
    if (["-u", "--unset", "-C", "--chdir", "--block-signal",
      "--default-signal", "--ignore-signal"].includes(argument)) {
      if (argumentsList[index + 1] === undefined) return { classification: "unmodeled" };
      index += 2;
      continue;
    }
    if (/^-(?:u|C).+/u.test(argument) || /^--(?:unset|chdir)=/u.test(argument)) {
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) return { classification: "unmodeled" };
    break;
  }
  const executable = argumentsList[index];
  return executable === undefined
    ? { classification: "modeled-non-git" }
    : { classification: "command", executable, argumentsList: argumentsList.slice(index + 1) };
}

function classifyExecutableAndArguments(
  executable: string,
  argumentsList: readonly string[],
): GitInvocationClassification {
  if (isGitExecutable(executable)) return "git";
  if (!isShellExecutable(executable)) return "modeled-non-git";
  const commandIndex = argumentsList.findIndex((argument) =>
    argument === "-c" || /^-[^-]*c[^-]*$/u.test(argument)
  );
  if (commandIndex < 0 || argumentsList[commandIndex + 1] === undefined) return "unmodeled";
  return classifyShellCommand(argumentsList[commandIndex + 1]!);
}

function isShellExecutable(value: string): boolean {
  return /(?:^|\/)(?:ba|da|k|z)?sh$/u.test(value.trim());
}

function isEnvironmentAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/u.test(value);
}

function isShellControlWord(value: string): boolean {
  return ["&&", "||", ";", "|", "&", "(", ")", "{", "}"].includes(value) ||
    /[;|&<>`$\n\r]/u.test(value);
}

function simpleShellWords(value: string): readonly string[] {
  const input = value.trim();
  const words: string[] = [];
  const pattern = /\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))/gyu;
  let index = 0;
  while (index < input.length) {
    pattern.lastIndex = index;
    const match = pattern.exec(input);
    if (!match || match.index !== index) return [];
    words.push(match[1] ?? match[2] ?? match[3]!);
    index = pattern.lastIndex;
  }
  return words;
}
