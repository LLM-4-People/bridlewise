import { deepFreeze } from "../kernel/integrity.ts";
import { InputError } from "../kernel/errors.ts";
import {
  type ExportInfo,
  type ImportInfo,
  type SymbolInfo,
  type SymbolKind,
  type SymbolLocation,
} from "./intelligence-types.ts";
import { getLanguageByExtension } from "./language-registry.ts";
import { extractSymbolsTreeSitter } from "./tree-sitter-extractor.ts";
import { DEFAULT_SOURCE_ANALYSIS_LIMIT } from "./intelligence-config.ts";
import { tokenizeWithPositions, type Token } from "./js-tokenizer.ts";

/**
 * Lightweight TypeScript/JavaScript symbol extractor.
 *
 * Reuses the tokenization technique from `scripts/verification/static-source.ts`
 * but extends it with line/column tracking and symbol-definition extraction.
 * The static-source tokenizer is intentionally a verification oracle that
 * disagrees with the Babel analyzer; this module is a production analysis tool
 * for repository intelligence. Both serve distinct purposes.
 *
 * The extractor is deliberately conservative: when it cannot confidently
 * classify a construct, it skips it rather than guessing. This prevents false
 * symbols from malformed or partial code.
 */

export type ExtractionResult = Readonly<{
  symbols: readonly SymbolInfo[];
  imports: readonly ImportInfo[];
  exports: readonly ExportInfo[];
  lineCount: number;
}>;

const FUNCTION_KEYWORDS = new Set(["function"] as const);
const DECLARATION_KEYWORDS = new Set(["const", "let", "var"] as const);

export function extractSymbols(filePath: string, source: string): ExtractionResult {
  if (typeof source !== "string") {
    throw new InputError("Source must be a string", "intelligence_source_not_string");
  }
  if (source.length > DEFAULT_SOURCE_ANALYSIS_LIMIT) {
    throw new InputError("Source exceeds the analysis limit", "intelligence_source_oversized");
  }
  // Tree-sitter languages (including JS/TS) parse via the tree-sitter
  // extractor. JS/TS keep the tokenizer for imports/exports and for
  // constructs the grammar does not emit as definition nodes (arrow
  // consts). Tree-sitter symbols win on name+kind so tokenizer param
  // over-count cannot beat a real parameter list.
  const lang = getLanguageByExtension(filePath);
  if (lang !== undefined && lang.treeSitter) {
    const tree = extractSymbolsTreeSitter(filePath, source);
    if (lang.id === "javascript" || lang.id === "typescript") {
      const tok = extractWithTokenizer(source);
      return deepFreeze({
        symbols: mergePreferTree(tree.symbols, tok.symbols),
        imports: tok.imports,
        exports: tok.exports,
        lineCount: tree.lineCount,
      });
    }
    return tree;
  }
  return extractWithTokenizer(source);
}

function mergePreferTree(
  tree: readonly SymbolInfo[],
  tok: readonly SymbolInfo[],
): readonly SymbolInfo[] {
  const key = (s: SymbolInfo): string => `${s.kind}:${s.name}:${s.location.line}`;
  const fromTree = new Set(tree.map(key));
  const extra = tok.filter((s) => !fromTree.has(key(s)) && !fromTree.has(`${s.kind}:${s.name}:1`));
  // Tree-sitter line numbers may not match tokenizer; also prefer by name+kind.
  const byNameKind = new Set(tree.map((s) => `${s.kind}:${s.name}`));
  const onlyTok = extra.filter((s) => !byNameKind.has(`${s.kind}:${s.name}`));
  return deepFreeze([...tree, ...onlyTok]);
}

function extractWithTokenizer(source: string): ExtractionResult {
  const tokens = tokenizeWithPositions(source);
  const symbols: SymbolInfo[] = [];
  const imports: ImportInfo[] = [];
  const exports: ExportInfo[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== "identifier") continue;

    if (token.value === "import") {
      const result = extractImport(tokens, i);
      if (result) {
        imports.push(result.import);
        i = result.nextIndex;
      }
      continue;
    }

    if (token.value === "export") {
      const result = extractExport(tokens, i, source);
      if (result) {
        if (result.export) exports.push(result.export);
        if (result.symbol) symbols.push(result.symbol);
        if (result.import) imports.push(result.import);
        i = result.nextIndex;
      }
      continue;
    }

    if (token.value === "async" && tokens[i + 1]?.value === "function") {
      const sym = extractFunctionDeclaration(tokens, i, false);
      if (sym) symbols.push(sym);
      continue;
    }

    if (FUNCTION_KEYWORDS.has(token.value as "function")) {
      const sym = extractFunctionDeclaration(tokens, i, false);
      if (sym) symbols.push(sym);
      continue;
    }

    if (token.value === "interface") {
      const sym = extractInterfaceOrType(tokens, i, "interface", false);
      if (sym) symbols.push(sym);
      continue;
    }

    if (token.value === "type") {
      const sym = extractInterfaceOrType(tokens, i, "type", false);
      if (sym) symbols.push(sym);
      continue;
    }

    if (token.value === "class") {
      const sym = extractClassDeclaration(tokens, i, false);
      if (sym) symbols.push(sym);
      continue;
    }

    if (DECLARATION_KEYWORDS.has(token.value as "const" | "let" | "var")) {
      const sym = extractVariableDeclaration(tokens, i, token.value as SymbolKind, false);
      if (sym) symbols.push(sym);
      continue;
    }

    if (token.value === "enum") {
      const sym = extractEnumDeclaration(tokens, i, false);
      if (sym) symbols.push(sym);
      continue;
    }

    if (token.value === "namespace") {
      const sym = extractNamespaceDeclaration(tokens, i, false);
      if (sym) symbols.push(sym);
      continue;
    }
  }

  const lineCount = countLines(source);
  return deepFreeze({
    symbols: deduplicateSymbols(symbols),
    imports: deduplicateImports(imports),
    exports: deduplicateExports(exports),
    lineCount,
  });
}

function extractImport(
  tokens: readonly Token[],
  start: number,
): Readonly<{ import: ImportInfo; nextIndex: number }> | null {
  const token = tokens[start]!;
  if (token.value !== "import") return null;
  if (tokens[start + 1]?.value === "." && tokens[start + 2]?.value === "meta") {
    return null;
  }
  if (tokens[start + 1]?.value === "type" && tokens[start + 2]?.value !== "{" && tokens[start + 2]?.kind !== "string") {
    return null;
  }
  let cursor = start + 1;
  if (tokens[cursor]?.value === "type") cursor += 1;
  const importedNames: string[] = [];
  if (tokens[cursor]?.kind === "string") {
    const specifier = tokens[cursor]!.value;
    return {
      import: { specifier, kind: "direct-import", importedNames: deepFreeze([]), resolvedPath: null },
      nextIndex: cursor,
    };
  }
  if (tokens[cursor]?.value === "*") {
    cursor += 1;
    if (tokens[cursor]?.value === "as") cursor += 1;
    if (tokens[cursor]?.kind === "identifier") cursor += 1;
  } else if (tokens[cursor]?.value === "{") {
    cursor += 1;
    while (cursor < tokens.length && tokens[cursor]?.value !== "}") {
      if (tokens[cursor]?.value === ",") { cursor += 1; continue; }
      if (tokens[cursor]?.value === "type") { cursor += 1; continue; }
      if (tokens[cursor]?.kind === "identifier") {
        importedNames.push(tokens[cursor]!.value);
        cursor += 1;
        if (tokens[cursor]?.value === "as" && tokens[cursor + 1]?.kind === "identifier") {
          cursor += 2;
        }
      } else {
        cursor += 1;
      }
    }
    if (tokens[cursor]?.value === "}") cursor += 1;
  } else if (tokens[cursor]?.kind === "identifier") {
    importedNames.push(tokens[cursor]!.value);
    cursor += 1;
  }
  let specifier: string | null = null;
  if (tokens[cursor]?.value === "from") {
    cursor += 1;
    if (tokens[cursor]?.kind === "string") {
      specifier = tokens[cursor]!.value;
      cursor += 1;
    }
  }
  if (specifier === null) return null;
  let kind: ImportInfo["kind"] = "direct-import";
  const next = tokens[cursor];
  if (next?.value === "(" && specifier.startsWith("data:") === false) {
    kind = "dynamic-import";
  }
  return {
    import: { specifier, kind, importedNames: deepFreeze(importedNames), resolvedPath: null },
    nextIndex: cursor - 1,
  };
}

type ExportExtraction = Readonly<{
  export: ExportInfo | null;
  symbol: SymbolInfo | null;
  import: ImportInfo | null;
  nextIndex: number;
}>;

function extractExport(
  tokens: readonly Token[],
  start: number,
  _source: string,
): ExportExtraction | null {
  const token = tokens[start]!;
  if (token.value !== "export") return null;
  let cursor = start + 1;
  if (tokens[cursor]?.value === "default") {
    cursor += 1;
    if (FUNCTION_KEYWORDS.has(tokens[cursor]?.value as "function")) {
      const sym = extractFunctionDeclaration(tokens, cursor, true);
      return {
        export: { name: "default", kind: "default", localName: sym?.name ?? null, sourceSpecifier: null },
        symbol: sym,
        import: null,
        nextIndex: sym ? findStatementEnd(tokens, start) : cursor,
      };
    }
    if (tokens[cursor]?.value === "class") {
      const sym = extractClassDeclaration(tokens, cursor, true);
      return {
        export: { name: "default", kind: "default", localName: sym?.name ?? null, sourceSpecifier: null },
        symbol: sym,
        import: null,
        nextIndex: sym ? findStatementEnd(tokens, start) : cursor,
      };
    }
    if (tokens[cursor]?.kind === "identifier") {
      const localName = tokens[cursor]!.value;
      return {
        export: { name: "default", kind: "default", localName, sourceSpecifier: null },
        symbol: null,
        import: null,
        nextIndex: findStatementEnd(tokens, start),
      };
    }
    return null;
  }
  if (tokens[cursor]?.value === "type" && (tokens[cursor + 1]?.value === "*" || tokens[cursor + 1]?.value === "{")) {
    cursor += 1;
  }
  if (tokens[cursor]?.value === "*") {
    cursor += 1;
    if (tokens[cursor]?.value === "as" && tokens[cursor + 1]?.kind === "identifier") cursor += 2;
    let sourceSpecifier: string | null = null;
    if (tokens[cursor]?.value === "from") {
      cursor += 1;
      if (tokens[cursor]?.kind === "string") {
        sourceSpecifier = tokens[cursor]!.value;
        cursor += 1;
      }
    }
    return {
      export: { name: "*", kind: "re-export", localName: null, sourceSpecifier },
      symbol: null,
      import: sourceSpecifier
        ? { specifier: sourceSpecifier, kind: "re-export", importedNames: deepFreeze([]), resolvedPath: null }
        : null,
      nextIndex: findStatementEnd(tokens, start),
    };
  }
  if (tokens[cursor]?.value === "{") {
    cursor += 1;
    const exportedNames: string[] = [];
    while (cursor < tokens.length && tokens[cursor]?.value !== "}") {
      if (tokens[cursor]?.value === ",") { cursor += 1; continue; }
      if (tokens[cursor]?.value === "type") { cursor += 1; continue; }
      if (tokens[cursor]?.kind === "identifier") {
        const localName = tokens[cursor]!.value;
        let exportName = localName;
        cursor += 1;
        if (tokens[cursor]?.value === "as" && tokens[cursor + 1]?.kind === "identifier") {
          exportName = tokens[cursor + 1]!.value;
          cursor += 2;
        }
        exportedNames.push(exportName);
      } else {
        cursor += 1;
      }
    }
    if (tokens[cursor]?.value === "}") cursor += 1;
    let sourceSpecifier: string | null = null;
    if (tokens[cursor]?.value === "from") {
      cursor += 1;
      if (tokens[cursor]?.kind === "string") {
        sourceSpecifier = tokens[cursor]!.value;
        cursor += 1;
      }
    }
    return {
      export: exportedNames.length > 0
        ? { name: exportedNames[0]!, kind: "re-export", localName: null, sourceSpecifier }
        : null,
      symbol: null,
      import: sourceSpecifier
        ? { specifier: sourceSpecifier, kind: "re-export", importedNames: deepFreeze(exportedNames), resolvedPath: null }
        : null,
      nextIndex: findStatementEnd(tokens, start),
    };
  }
  if (tokens[cursor]?.value === "async") cursor += 1;
  if (FUNCTION_KEYWORDS.has(tokens[cursor]?.value as "function")) {
    const sym = extractFunctionDeclaration(tokens, cursor, true);
    return {
      export: sym
        ? { name: sym.name, kind: "declared" as const, localName: sym.name, sourceSpecifier: null }
        : null,
      symbol: sym,
      import: null,
      nextIndex: sym ? findStatementEnd(tokens, start) : cursor,
    };
  }
  if (tokens[cursor]?.value === "interface") {
    const sym = extractInterfaceOrType(tokens, cursor, "interface", true);
    return {
      export: sym
        ? { name: sym.name, kind: "declared" as const, localName: sym.name, sourceSpecifier: null }
        : null,
      symbol: sym,
      import: null,
      nextIndex: sym ? findStatementEnd(tokens, start) : cursor,
    };
  }
  if (tokens[cursor]?.value === "type") {
    const sym = extractInterfaceOrType(tokens, cursor, "type", true);
    return {
      export: sym
        ? { name: sym.name, kind: "declared" as const, localName: sym.name, sourceSpecifier: null }
        : null,
      symbol: sym,
      import: null,
      nextIndex: sym ? findStatementEnd(tokens, start) : cursor,
    };
  }
  if (tokens[cursor]?.value === "class") {
    const sym = extractClassDeclaration(tokens, cursor, true);
    return {
      export: sym
        ? { name: sym.name, kind: "declared" as const, localName: sym.name, sourceSpecifier: null }
        : null,
      symbol: sym,
      import: null,
      nextIndex: sym ? findStatementEnd(tokens, start) : cursor,
    };
  }
  if (DECLARATION_KEYWORDS.has(tokens[cursor]?.value as "const" | "let" | "var")) {
    const sym = extractVariableDeclaration(tokens, cursor, tokens[cursor]!.value as SymbolKind, true);
    return {
      export: sym
        ? { name: sym.name, kind: "declared" as const, localName: sym.name, sourceSpecifier: null }
        : null,
      symbol: sym,
      import: null,
      nextIndex: sym ? findStatementEnd(tokens, start) : cursor,
    };
  }
  if (tokens[cursor]?.value === "enum") {
    const sym = extractEnumDeclaration(tokens, cursor, true);
    return {
      export: sym
        ? { name: sym.name, kind: "declared" as const, localName: sym.name, sourceSpecifier: null }
        : null,
      symbol: sym,
      import: null,
      nextIndex: sym ? findStatementEnd(tokens, start) : cursor,
    };
  }
  if (tokens[cursor]?.value === "namespace") {
    const sym = extractNamespaceDeclaration(tokens, cursor, true);
    return {
      export: sym
        ? { name: sym.name, kind: "declared" as const, localName: sym.name, sourceSpecifier: null }
        : null,
      symbol: sym,
      import: null,
      nextIndex: sym ? findStatementEnd(tokens, start) : cursor,
    };
  }
  return null;
}

function extractFunctionDeclaration(
  tokens: readonly Token[],
  start: number,
  exported: boolean,
): SymbolInfo | null {
  let cursor = start;
  let async = false;
  if (tokens[cursor]?.value === "async") {
    async = true;
    cursor += 1;
  }
  if (tokens[cursor]?.value !== "function") return null;
  cursor += 1;
  let generator = false;
  if (tokens[cursor]?.value === "*") {
    generator = true;
    cursor += 1;
  }
  const nameToken = tokens[cursor];
  if (nameToken?.kind !== "identifier") return null;
  const name = nameToken.value;
  cursor += 1;
  const paramCount = countParameters(tokens, cursor);
  const location: SymbolLocation = {
    filePath: "",
    line: nameToken.line,
    column: nameToken.column,
  };
  return {
    name,
    kind: "function",
    visibility: exported ? "exported" : "local",
    location,
    exported,
    async,
    generator,
    parameterCount: paramCount,
    modifiers: buildModifiers(async, generator, exported),
  };
}

function extractClassDeclaration(
  tokens: readonly Token[],
  start: number,
  exported: boolean,
): SymbolInfo | null {
  let cursor = start;
  let abstract = false;
  if (tokens[cursor]?.value === "abstract") {
    abstract = true;
    cursor += 1;
  }
  if (tokens[cursor]?.value !== "class") return null;
  cursor += 1;
  const nameToken = tokens[cursor];
  if (nameToken?.kind !== "identifier") return null;
  const name = nameToken.value;
  const modifiers = abstract ? ["abstract"] : [];
  return {
    name,
    kind: "class",
    visibility: exported ? "exported" : "local",
    location: { filePath: "", line: nameToken.line, column: nameToken.column },
    exported,
    async: false,
    generator: false,
    parameterCount: 0,
    modifiers: deepFreeze(modifiers),
  };
}

function extractInterfaceOrType(
  tokens: readonly Token[],
  start: number,
  kind: "interface" | "type",
  exported: boolean,
): SymbolInfo | null {
  if (tokens[start]?.value !== kind) return null;
  const nameToken = tokens[start + 1];
  if (nameToken?.kind !== "identifier") return null;
  const name = nameToken.value;
  return {
    name,
    kind,
    visibility: exported ? "exported" : "local",
    location: { filePath: "", line: nameToken.line, column: nameToken.column },
    exported,
    async: false,
    generator: false,
    parameterCount: 0,
    modifiers: deepFreeze([]),
  };
}

function extractVariableDeclaration(
  tokens: readonly Token[],
  start: number,
  kind: SymbolKind,
  exported: boolean,
): SymbolInfo | null {
  if (!DECLARATION_KEYWORDS.has(kind as "const" | "let" | "var")) return null;
  const nameToken = tokens[start + 1];
  if (nameToken?.kind !== "identifier") return null;
  const name = nameToken.value;
  let isAsync = false;
  let paramCount = 0;
  for (let i = start + 2; i < tokens.length && i < start + 20; i++) {
    if (tokens[i]?.value === "=") {
      if (tokens[i + 1]?.value === "async") isAsync = true;
      const parenIndex = tokens.slice(i + 1, i + 10).findIndex((t) => t.value === "(");
      if (parenIndex >= 0) {
        paramCount = countParameters(tokens, i + 1 + parenIndex);
        if (tokens[i + 1 + parenIndex + 1]?.value === ")" && tokens[i + 2 + parenIndex]?.value === "=>") {
          isAsync = isAsync || tokens[i + 1]?.value === "async";
        }
      }
      break;
    }
    if (tokens[i]?.value === ";" || tokens[i]?.value === "\n") break;
  }
  return {
    name,
    kind,
    visibility: exported ? "exported" : "local",
    location: { filePath: "", line: nameToken.line, column: nameToken.column },
    exported,
    async: isAsync,
    generator: false,
    parameterCount: paramCount,
    modifiers: deepFreeze([]),
  };
}

function extractEnumDeclaration(
  tokens: readonly Token[],
  start: number,
  exported: boolean,
): SymbolInfo | null {
  if (tokens[start]?.value !== "enum") return null;
  const nameToken = tokens[start + 1];
  if (nameToken?.kind !== "identifier") return null;
  return {
    name: nameToken.value,
    kind: "enum",
    visibility: exported ? "exported" : "local",
    location: { filePath: "", line: nameToken.line, column: nameToken.column },
    exported,
    async: false,
    generator: false,
    parameterCount: 0,
    modifiers: deepFreeze([]),
  };
}

function extractNamespaceDeclaration(
  tokens: readonly Token[],
  start: number,
  exported: boolean,
): SymbolInfo | null {
  if (tokens[start]?.value !== "namespace") return null;
  const nameToken = tokens[start + 1];
  if (nameToken?.kind !== "identifier") return null;
  return {
    name: nameToken.value,
    kind: "namespace",
    visibility: exported ? "exported" : "local",
    location: { filePath: "", line: nameToken.line, column: nameToken.column },
    exported,
    async: false,
    generator: false,
    parameterCount: 0,
    modifiers: deepFreeze([]),
  };
}

function countParameters(tokens: readonly Token[], openParenIndex: number): number {
  if (tokens[openParenIndex]?.value !== "(") return 0;
  let depth = 0;
  let count = 0;
  let hasContent = false;
  for (let i = openParenIndex + 1; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.value === "(" || t.value === "[" || t.value === "{") depth += 1;
    else if (t.value === ")" || t.value === "]" || t.value === "}") {
      if (depth === 0 && t.value === ")") return hasContent ? count : 0;
      depth -= 1;
    }
    if (depth === 0) {
      if (t.kind === "identifier" || t.value === "..." || t.value === "{" || t.value === "[") {
        if (t.value === "{" || t.value === "[") {
          count += 1;
          depth += 1;
        } else if (t.kind === "identifier" && t.value !== "=" && t.value !== ":") {
          count += 1;
        }
        hasContent = true;
      } else if (t.value === "," && hasContent) {
        continue;
      }
    }
  }
  return count;
}

function findStatementEnd(tokens: readonly Token[], start: number): number {
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    const v = tokens[i]!.value;
    if (v === "{" || v === "(" || v === "[") {
      depth += 1;
    } else if (v === "}") {
      if (depth > 0) depth -= 1;
      // A closing brace returning to depth 0 ends a block-bodied statement
      // (function/class/interface/enum/namespace body or `export {... }`).
      if (depth === 0) return i;
    } else if (v === ")" || v === "]") {
      // Parens/brackets returning to depth 0 (e.g. a parameter list) do NOT
      // end the statement: the function body or return type follows.
      if (depth > 0) depth -= 1;
    } else if (depth === 0 && v === ";") {
      return i;
    }
  }
  return Math.min(start + 200, tokens.length - 1);
}

function buildModifiers(async: boolean, generator: boolean, exported: boolean): readonly string[] {
  const mods: string[] = [];
  if (async) mods.push("async");
  if (generator) mods.push("generator");
  if (exported) mods.push("exported");
  return deepFreeze(mods);
}

function deduplicateSymbols(symbols: readonly SymbolInfo[]): readonly SymbolInfo[] {
  const seen = new Set<string>();
  const result: SymbolInfo[] = [];
  for (const sym of symbols) {
    const key = `${sym.name}:${sym.kind}:${sym.location.line}:${sym.location.column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(sym);
  }
  return deepFreeze(result);
}

function deduplicateImports(imports: readonly ImportInfo[]): readonly ImportInfo[] {
  const seen = new Set<string>();
  const result: ImportInfo[] = [];
  for (const imp of imports) {
    const key = `${imp.specifier}:${imp.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(imp);
  }
  return deepFreeze(result);
}

function deduplicateExports(exports: readonly ExportInfo[]): readonly ExportInfo[] {
  const seen = new Set<string>();
  const result: ExportInfo[] = [];
  for (const exp of exports) {
    const key = `${exp.name}:${exp.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(exp);
  }
  return deepFreeze(result);
}

function countLines(source: string): number {
  if (source.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") count += 1;
  }
  return count;
}
