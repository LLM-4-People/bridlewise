/**
 * Language adapter registry. The engine dispatches each file to the
 * adapter whose `extensions` include the file's extension. Adapters are
 * pure functions `(filePath, source) => FileAnalysis`; they never touch
 * the filesystem or hold state.
 *
 * Adding a language = add one file in `languages/` and register it here.
 * No other module needs to change.
 */
import type { FileAnalysis } from "../types.ts";
import type { LanguageConfig } from "../config.ts";
import { analyzeTypeScript } from "./typescript.ts";
// Real-parser adapters (tree-sitter). Each falls back to the line+regex
// adapter if the tree-sitter native binding is unavailable.
import { analyzePython } from "./python-tree-sitter.ts";
import { analyzeRust } from "./rust-tree-sitter.ts";
import { analyzeGo } from "./go-tree-sitter.ts";
import { analyzeGeneric } from "./generic.ts";

/** A language adapter: analyze one source file. */
export type LanguageAdapter = Readonly<{
  /** The language config this adapter owns. */
  config: LanguageConfig;
  /** Analyze a source file. `source` is the full file content. */
  analyze: (filePath: string, source: string) => Omit<FileAnalysis, "filePath" | "languageId" | "contentHash">;
}>;

/** Built-in adapters. The engine builds this map at construction time. */
export const ADAPTERS: readonly LanguageAdapter[] = [
  { config: { id: "typescript", label: "TypeScript/JavaScript", extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"], commentLinePrefixes: ["//", "/*", "*"] }, analyze: analyzeTypeScript },
  { config: { id: "python",     label: "Python",                extensions: [".py"],                                                                commentLinePrefixes: ["#"] },                                                              analyze: analyzePython },
  { config: { id: "rust",       label: "Rust",                  extensions: [".rs"],                                                                commentLinePrefixes: ["//", "/*", "*"] },                                                  analyze: analyzeRust },
  { config: { id: "go",         label: "Go",                    extensions: [".go"],                                                                commentLinePrefixes: ["//", "/*", "*"] },                                                  analyze: analyzeGo },
];

/** Look up an adapter by file extension (lowercase). */
export function adapterForExtension(ext: string, adapters: readonly LanguageAdapter[] = ADAPTERS): LanguageAdapter | null {
  for (const a of adapters) {
    if (a.config.extensions.includes(ext)) return a;
  }
  return null;
}

/** Look up an adapter by language id. */
export function adapterForLanguage(id: string, adapters: readonly LanguageAdapter[] = ADAPTERS): LanguageAdapter | null {
  for (const a of adapters) {
    if (a.config.id === id) return a;
  }
  return null;
}

/** Map of language id → config, for signal modules. */
export function languageConfigMap(adapters: readonly LanguageAdapter[] = ADAPTERS): ReadonlyMap<string, LanguageConfig> {
  const m = new Map<string, LanguageConfig>();
  for (const a of adapters) m.set(a.config.id, a.config);
  return m;
}

/** Generic fallback adapter (used when no language matches). */
export const GENERIC_ADAPTER: LanguageAdapter = {
  config: { id: "generic", label: "Generic", extensions: [], commentLinePrefixes: ["//", "#", "/*", "*"] },
  analyze: analyzeGeneric,
};
