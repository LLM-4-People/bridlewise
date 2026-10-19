import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { deepFreeze } from "../kernel/integrity.ts";
import { InputError } from "../kernel/errors.ts";
import { atomicWriteFile } from "../filesystem/atomic-write.ts";
import { shouldExcludeExperiment } from "../shared/source-scan.ts";

/**
 * Mechanical format auto-fixer (EXP481).
 *
 * The candidate-format check (`scripts/verification/candidate-format.ts`) is
 * the canonical detector for text-byte format violations. This module is the
 * matching auto-fixer: it scans `.ts` files and repairs the trivially
 * auto-fixable mechanical issues — the same kinds the prevention test
 * `test/prevention/no-excess-trailing-newlines.test.ts` enforces:
 *
 * - trailing-whitespace → stripped from every line
 * - carriage-return → normalized to `\n` (CRLF → LF)
 * - byte-order-mark → stripped from the file head
 * - excess-final-newline → collapsed to exactly one `\n`
 * - missing-final-newline → appended (`\n` added at EOF)
 *
 * Non-mechanical issues (nul bytes, invalid-utf8) indicate corruption, not
 * formatting, and are intentionally NOT auto-fixed — they must be investigated
 * manually. The fixer reports how many files were changed so the operator
 * knows the repair ran.
 *
 * The fixer is exposed as `harness format` (see `src/workflow/harness-commands.ts`)
 * and is the one-command repair for the mechanical trailing-newline /
 * trailing-whitespace class of regressions. It reuses `atomicWriteFile` (the
 * canonical atomic-write primitive) so a fix is all-or-nothing per file.
 */

export type FormatFixKind =
  | "excess-final-newline"
  | "missing-final-newline"
  | "trailing-whitespace"
  | "carriage-return"
  | "byte-order-mark";

export type FormatFileResult = Readonly<{
  path: string;
  changed: boolean;
  /** The kinds fixed in this file (empty when unchanged). */
  fixes: readonly FormatFixKind[];
}>;

export type FormatResult = Readonly<{
  scanned: number;
  fixed: number;
  results: readonly FormatFileResult[];
}>;

const FORMAT_SCAN_DIRS = deepFreeze(["src", "test", "scripts", "verification"] as const);
const FORMAT_SCAN_EXTENSIONS = deepFreeze([".ts"] as const);

/**
 * Apply the mechanical format fix to a file's bytes. Pure function: takes the
 * raw bytes, returns the fixed bytes + the kinds fixed. Returns `changed:
 * false` when the bytes are already canonical so the caller can skip the
 * write (avoiding a needless inode mutation).
 */
export function fixFileBytes(bytes: Uint8Array): Readonly<{ bytes: Buffer; fixes: readonly FormatFixKind[] }> {
  if (bytes.length === 0) return { bytes: Buffer.alloc(0), fixes: [] };
  const fixes: FormatFixKind[] = [];
  // Strip UTF-8 BOM (0xEF 0xBB 0xBF) from the head.
  let start = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    start = 3;
    fixes.push("byte-order-mark");
  }
  let text = Buffer.from(bytes.subarray(start)).toString("utf8");
  // Normalize CRLF (\r\n) and lone \r to \n.
  if (text.includes("\r")) {
    text = text.replace(/\r\n?/gu, "\n");
    fixes.push("carriage-return");
  }
  // Strip trailing whitespace from each line. The regex matches spaces/tabs
  // before a newline (or at end of string) without consuming the newline.
  const lines = text.split("\n");
  let strippedAny = false;
  for (let i = 0; i < lines.length; i += 1) {
    const stripped = lines[i]!.replace(/[ \t]+$/u, "");
    if (stripped !== lines[i]) {
      strippedAny = true;
      lines[i] = stripped;
    }
  }
  if (strippedAny) fixes.push("trailing-whitespace");
  text = lines.join("\n");
  // Collapse trailing blank lines and ensure exactly one final newline.
  // Record whether the original had an excess or missing final newline so
  // the fix list is accurate (the kinds are determined from the original
  // bytes, before normalization).
  if (bytes.length >= 2 && bytes[bytes.length - 1] === 0x0a && bytes[bytes.length - 2] === 0x0a) {
    fixes.push("excess-final-newline");
  }
  if (bytes[bytes.length - 1] !== 0x0a) {
    fixes.push("missing-final-newline");
  }
  text = text.replace(/\n+$/u, "");
  text = `${text}\n`;
  const fixed = Buffer.from(text, "utf8");
  const changed = fixes.length > 0 || !fixed.equals(Buffer.from(bytes));
  return { bytes: fixed, fixes: changed ? deepFreeze([...new Set(fixes)]) : deepFreeze([]) };
}

function listTsFiles(dir: string, root: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    const relativePath = relative(root, fullPath).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      if (shouldExcludeExperiment(relativePath)) continue;
      listTsFiles(fullPath, root, acc);
    } else if (entry.isFile() && FORMAT_SCAN_EXTENSIONS.some((ext) => entry.name.endsWith(ext)) && !entry.name.endsWith(".d.ts")) {
      if (shouldExcludeExperiment(relativePath)) continue;
      acc.push(fullPath);
    }
  }
  return acc;
}

export function harnessFormat(
  root: string,
  options: Readonly<{ write?: boolean }> = {},
): Readonly<{ scanned: number; fixed: number; results: readonly FormatFileResult[]; write: boolean }> {
  const write = options.write ?? false;
  const files: string[] = [];
  for (const dir of FORMAT_SCAN_DIRS) listTsFiles(join(root, dir), root, files);
  // AN EMPTY SCAN IS A REFUSAL, NOT A CLEAN RESULT.
  //
  // A missing directory is skipped one at a time, and that is correct — not
  // every project has every scan directory. What is not correct is the UNION
  // being empty and the command reporting `scanned: 0, fixed: 0`, which reads
  // as "formatted, nothing to fix" and is indistinguishable from it. That is
  // an unmeasured quantity reported as a zero: the caller is told a fact about
  // the code when the truth is that no code was found.
  //
  // The floor is on the union rather than per directory precisely because
  // per-directory absence is legitimate; only "none of them" is a claim
  // nobody should make silently. The message names what was looked for and
  // where, so the answer is a way out rather than an internal path the caller
  // was never told about.
  if (files.length === 0) {
    throw new InputError(
      `harness format: no source files under ${root}. Looked in ${FORMAT_SCAN_DIRS.join(", ")}. ` +
      `Point the command at the project root, or add the directories it should format.`,
      "format_scan_empty",
    );
  }
  files.sort();
  const results: FormatFileResult[] = [];
  let fixed = 0;
  for (const file of files) {
    const bytes = readFileSync(file);
    const { bytes: fixedBytes, fixes } = fixFileBytes(bytes);
    const relativePath = relative(root, file).replaceAll("\\", "/");
    const changed = fixes.length > 0;
    if (changed) {
      fixed += 1;
      if (write) {
        const writeResult = atomicWriteFile(file, fixedBytes.toString("utf8"));
        if (!writeResult.success) {
          throw new InputError(`harness format: could not write ${relativePath}: ${writeResult.reason ?? "unknown"}`, "format_write_failed");
        }
      }
    }
    results.push(deepFreeze({ path: relativePath, changed, fixes: [...fixes] }));
  }
  return deepFreeze({ scanned: files.length, fixed, results: deepFreeze(results), write });
}
