/**
 * Language parser registry (EXP368).
 *
 * ONE canonical owner for the language → parser mapping. Adding a language
 * = adding a parser entry here. All checks consume `parseFiles`, which is
 * language-agnostic.
 *
 * The per-language parsers live in `languages/<lang>/parser.ts` and each
 * returns `Promise<ParsedFile>` (uniform async interface — tree-sitter WASM
 * loads are async; babel's sync result is wrapped in `Promise.resolve`).
 */

import type { LanguageId, ParsedFile } from "../base.ts";
import { detectLanguage } from "../config.ts";
import { parseC } from "./c-cpp/parser.ts";
import { parseGo } from "./go/parser.ts";
import { parseJsTs } from "./js-ts/parser.ts";
import { parseJava } from "./java/parser.ts";
import { parsePython } from "./python/parser.ts";
import { parseRust } from "./rust/parser.ts";

export async function parseSourceFile(path: string, content: string): Promise<ParsedFile | null> {
  const language = detectLanguage(path);
  switch (language) {
    case "javascript":
      return Promise.resolve(parseJsTs(path, content, false));
    case "typescript":
      return Promise.resolve(parseJsTs(path, content, true));
    case "python":
      return parsePython(path, content);
    case "rust":
      return parseRust(path, content);
    case "go":
      return parseGo(path, content);
    case "java":
      return parseJava(path, content);
    case "c":
    case "cpp":
      return parseC(path, content);
    case "unknown":
      return null;
    default:
      return null;
  }
}

/** Parse a map of `{ relativePath: content }`. Returns only parseable files,
 * preserving the caller's path filtering.
 *
 * Parses files SEQUENTIALLY (not in parallel) because the tree-sitter WASM
 * runtime is not safe for concurrent access from multiple parsers — parallel
 * parsing causes `Aborted` crashes. The language wasm is loaded once and
 * cached; per-file parsing is sync and fast (~1-3ms). */
export async function parseFiles(
  files: Readonly<Record<string, string>>,
  languageFilter: ReadonlySet<LanguageId>,
): Promise<readonly ParsedFile[]> {
  const out: ParsedFile[] = [];
  for (const [path, content] of Object.entries(files)) {
    const language = detectLanguage(path);
    if (!languageFilter.has(language)) continue;
    const parsed = await parseSourceFile(path, content);
    if (parsed) out.push(parsed);
  }
  return out;
}
