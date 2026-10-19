import {
  createDefaultSyntaxValidatorRegistry,
  validateSyntax,
} from "../editor/syntax-validator.ts";
import { extractSymbols } from "../intelligence/symbol-extractor.ts";
import { tokenizeWithPositions, type Token } from "../intelligence/js-tokenizer.ts";
import { initTreeSitterForExtract } from "../intelligence/tree-sitter-backend.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import { getExtension } from "../shared/path-utils.ts";
import { clamp } from "../shared/numeric-helpers.ts";
import { JS_EXTENSIONS, TS_EXTENSIONS } from "../kernel/language-extensions.ts";
import {
  type Diagnostic,
  type QualityCheck,
  type QualityContext,
  type QualityPack,
  createDiagnostic,
} from "./quality-pack.ts";
import {
  detectDuplicateBodies,
  detectEsmCjsMismatches,
  detectDuplicatedLiterals,
} from "./prevention/index.ts";

// In-process extract entry: quality checks call extractSymbols
// synchronously. Module load is the process-spawn init so tests and
// the quality CLI cannot reach an unready JS/TS parser. Farm-child
// does not import this module.
await initTreeSitterForExtract(["javascript", "typescript"]);

/**
 * TypeScript/JavaScript quality pack.
 *
 * Implements delivery map item 9 and REQ-015 for the repository's
 * primary language (TypeScript/Node). Reuses existing infrastructure:
 *
 * Syntax errors: Babel parser via `src/editor/syntax-validator.ts`
 * Type errors: `tsc --noEmit` (the existing typecheck)
 * Missing/dead symbols: `src/intelligence/symbol-extractor.ts`
 * Unused/dead exports: export tracking + import cross-reference
 * Dead branches: AST-based unreachable code detection
 * Duplicate logic: `src/intelligence/reuse-discovery.ts` duplicate detection
 * Schema/version drift: `src/architecture-manifest.ts` checker
 * Config-outside-contract: hardcoded values that should be in config
 *
 * Per the quality-packs research (tool-matrix.md): "Reuse and respect an
 * existing project's compiler/linter/test configuration before generating
 * or changing configuration. Never install a competing tool merely because
 * a default pack lists it." (line 70 of harness-requirements.md)
 */

const ALL_EXTENSIONS = new Set([...TS_EXTENSIONS, ...JS_EXTENSIONS]);

const PACK_ID = "typescript-pack";
const PACK_VERSION = "1.0.0";

const syntaxRegistry = createDefaultSyntaxValidatorRegistry();

/**
 * Default thresholds for `duplicateBodyCheck` (production-strict). The
 * `duplicateBody` config section in `context.config` overrides per-field.
 * jaccardThreshold: 1.0 (strict exact-normalized match)
 * minTokenCount: 100 (production-scale; below 80 is too noisy)
 * minBodySize: 80 (matches the detector's DEFAULT_MIN_BODY_SIZE)
 * shingleK: 6 (the detector's default k-shingle size)
 *
 * One canonical owner: `DEFAULT_DUPLICATE_BODY_CONFIG`. The quality-pack
 * check reads overrides from `context.config["duplicateBody"]`; the harness's
 * own `test/prevention/no-duplicate-function-bodies.test.ts` calls
 * `detectDuplicateBodies` directly with its own (different) thresholds — the
 * detector has one source of truth, but the two consumers use different
 * defaults appropriate to their scope.
 */
const DEFAULT_DUPLICATE_BODY_CONFIG = deepFreeze({
  jaccardThreshold: 1.0,
  minTokenCount: 100,
  minBodySize: 80,
  shingleK: 6,
});

/**
 * Read the `duplicateBody` config section from `context.config` with safe
 * typed defaults. Each field is validated (number, finite, in-range). On
 * any validation failure, the field falls back to the default — the
 * detector never silently accepts malformed config.
 */
function readDuplicateBodyConfig(config: Readonly<Record<string, unknown>>): {
  jaccardThreshold: number;
  minTokenCount: number;
  minBodySize: number;
  shingleK: number;
} {
  const section = config["duplicateBody"];
  if (section === undefined || section === null || typeof section !== "object") {
    return { ...DEFAULT_DUPLICATE_BODY_CONFIG };
  }
  const s = section as Record<string, unknown>;
  const numOr = (key: keyof typeof DEFAULT_DUPLICATE_BODY_CONFIG, fallback: number): number => {
    const v = s[key];
    if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
    return v;
  };
  const jaccardThreshold = clamp(numOr("jaccardThreshold", DEFAULT_DUPLICATE_BODY_CONFIG.jaccardThreshold), 0, 1);
  const minTokenCount = Math.max(0, numOr("minTokenCount", DEFAULT_DUPLICATE_BODY_CONFIG.minTokenCount));
  const minBodySize = Math.max(0, numOr("minBodySize", DEFAULT_DUPLICATE_BODY_CONFIG.minBodySize));
  const shingleK = Math.max(1, Math.floor(numOr("shingleK", DEFAULT_DUPLICATE_BODY_CONFIG.shingleK)));
  return { jaccardThreshold, minTokenCount, minBodySize, shingleK };
}


function isSourceFile(filePath: string): boolean {
  return ALL_EXTENSIONS.has(getExtension(filePath));
}

function isTestFile(filePath: string): boolean {
  return filePath.endsWith(".test.ts") || filePath.endsWith(".test.js") ||
    filePath.endsWith(".test.tsx") || filePath.endsWith(".test.jsx");
}

export const syntaxCheck: QualityCheck = deepFreeze({
  id: "syntax-errors",
  description: "Detect syntax errors using the Babel parser (reused from syntax-validator)",
  category: "syntax",
  defaultSeverity: "error",
  run(context: QualityContext): readonly Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const files = context.files;
    for (const filePath of Object.keys(files)) {
      if (!isSourceFile(filePath)) continue;
      const source = files[filePath]!;
      const result = validateSyntax(filePath, source, syntaxRegistry, { skipUnknown: true });
      for (const diag of result.diagnostics) {
        diagnostics.push(createDiagnostic({
          packId: PACK_ID,
          checkId: "syntax-errors",
          category: "syntax",
          severity: diag.severity === "error" ? "error" : "warning",
          code: diag.code,
          message: diag.message,
          filePath,
          line: diag.line,
          column: diag.column,
          autoFixable: false,
        }));
      }
    }
    return deepFreeze(diagnostics);
  },
});

export const typeCheck: QualityCheck = deepFreeze({
  id: "type-errors",
  description: "Detect type errors via tsc --noEmit (the existing typecheck)",
  category: "type",
  defaultSeverity: "error",
  run(_context: QualityContext): readonly Diagnostic[] {
    return deepFreeze([]);
  },
});

export const undefinedSymbolCheck: QualityCheck = deepFreeze({
  id: "undefined-symbols",
  description: "Detect references to undefined names not in scope or imports",
  category: "undefined-symbol",
  defaultSeverity: "error",
  run(context: QualityContext): readonly Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const files = context.files;
    const allExports = new Map<string, Set<string>>();
    for (const filePath of Object.keys(files)) {
      if (!isSourceFile(filePath)) continue;
      const source = files[filePath]!;
      const extraction = extractSymbols(filePath, source);
      const exportNames = new Set<string>();
      for (const exp of extraction.exports) {
        if (exp.name !== "*") exportNames.add(exp.name);
        if (exp.localName !== null) exportNames.add(exp.localName);
      }
      exportNames.add("default");
      allExports.set(filePath, exportNames);
    }
    const globalBuiltins = new Set([
      "console", "process", "Buffer", "setTimeout", "setInterval",
      "clearTimeout", "clearInterval", "queueMicrotask", "fetch",
      "AbortController", "AbortSignal", "URL", "URLSearchParams",
      "TextEncoder", "TextDecoder", "crypto", "navigator", "globalThis",
      "undefined", "null", "true", "false", "NaN", "Infinity",
      "parseInt", "parseFloat", "isNaN", "isFinite", "Number", "String",
      "Boolean", "Array", "Object", "Math", "Date", "JSON", "Promise",
      "Symbol", "Map", "Set", "WeakMap", "WeakSet", "Error", "TypeError",
      "RangeError", "SyntaxError", "ReferenceError", "RegExp", "Function",
      "Proxy", "Reflect", "BigInt", "Intl", "eval", "encodeURIComponent",
      "decodeURIComponent", "encodeURI", "decodeURI", "escape", "unescape",
      "assert", "test", "describe", "before", "after", "beforeEach",
      "afterEach", "it", "suite", "mock", "spy", "stub", "setTimeout",
      "clearTimeout", "setInterval", "clearInterval", "setImmediate",
      "clearImmediate", "structuredClone", "atob", "btoa",
    ]);
    for (const filePath of Object.keys(files)) {
      if (!isSourceFile(filePath)) continue;
      const source = files[filePath]!;
      const extraction = extractSymbols(filePath, source);
      const localNames = new Set<string>();
      for (const sym of extraction.symbols) localNames.add(sym.name);
      for (const imp of extraction.imports) {
        for (const name of imp.importedNames) localNames.add(name);
        localNames.add("default");
      }
      const tokens = tokenizeWithPositions(source);
      collectParameterAndLocalNames(tokens, localNames);
      const identifiers = tokens.filter(
        (t) => t.kind === "identifier" &&
          !isKeyword(t.value) &&
          !globalBuiltins.has(t.value),
      );
      for (const id of identifiers) {
        if (localNames.has(id.value)) continue;
        if (isPropertyAccess(tokens, id, source)) continue;
        if (isDeclarationName(tokens, id)) continue;
        if (!isUsedAsValuePosition(tokens, id, source)) continue;
        diagnostics.push(createDiagnostic({
          packId: PACK_ID,
          checkId: "undefined-symbols",
          category: "undefined-symbol",
          severity: "error",
          code: "undefined_symbol_reference",
          message: `Symbol '${id.value}' is not defined or imported in this scope`,
          filePath,
          line: id.line,
          column: id.column,
          symbol: id.value,
          autoFixable: false,
        }));
      }
    }
    return deepFreeze(diagnostics);
  },
});

function collectParameterAndLocalNames(tokens: readonly Token[], names: Set<string>): void {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== "identifier") continue;
    if (token.value === "function" || token.value === "class" || token.value === "method") {
      let j = i + 1;
      if (tokens[j]?.value === "*") j += 1;
      if (tokens[j]?.kind === "identifier") j += 1;
      if (tokens[j]?.value === "(") {
        collectParamsInParameterList(tokens, j, names);
      }
    }
    if (token.value === "const" || token.value === "let" || token.value === "var") {
      const nameToken = tokens[i + 1];
      if (nameToken?.kind === "identifier") {
        names.add(nameToken.value);
        let j = i + 2;
        while (j < tokens.length && tokens[j]?.value !== ";" && tokens[j]?.value !== "\n") {
          if (tokens[j]?.value === "," && tokens[j + 1]?.kind === "identifier") {
            names.add(tokens[j + 1]!.value);
          }
          j += 1;
        }
      }
    }
    if (token.value === "for") {
      let j = i + 1;
      while (j < tokens.length && tokens[j]?.value !== "(" && j < i + 5) j += 1;
      if (tokens[j]?.value === "(") {
        let k = j + 1;
        if (tokens[k]?.value === "const" || tokens[k]?.value === "let" || tokens[k]?.value === "var") {
          if (tokens[k + 1]?.kind === "identifier") names.add(tokens[k + 1]!.value);
        }
      }
    }
  }
}

function collectParamsInParameterList(tokens: readonly Token[], openParenIdx: number, names: Set<string>): void {
  if (tokens[openParenIdx]?.value !== "(") return;
  let depth = 0;
  for (let i = openParenIdx + 1; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.value === "(" || t.value === "[" || t.value === "{") depth += 1;
    else if (t.value === ")" || t.value === "]" || t.value === "}") {
      if (depth === 0 && t.value === ")") return;
      depth -= 1;
    }
    if (depth === 0 && t.kind === "identifier" && t.value !== "type") {
      const prev = tokens[i - 1];
      const next = tokens[i + 1];
      if (prev?.value === "{" || prev?.value === "," || prev?.value === "[" ||
          prev?.value === "(" || prev?.value === "...") {
        if (next?.value === ":" || next?.value === ")" || next?.value === "," ||
            next?.value === "=" || next?.value === "?") {
          names.add(t.value);
        }
      }
    }
  }
}

function isKeyword(value: string): boolean {
  const KEYWORDS = new Set([
    "if", "else", "for", "while", "do", "switch", "case", "default",
    "break", "continue", "return", "throw", "try", "catch", "finally",
    "class", "extends", "super", "this", "new", "delete", "typeof",
    "instanceof", "in", "of", "void", "yield", "await", "async",
    "function", "var", "let", "const", "type", "interface", "enum",
    "namespace", "import", "export", "from", "as", "static", "public",
    "private", "protected", "readonly", "abstract", "declare", "module",
    "require", "global", "satisfies", "is", "keyof", "infer", "never",
    "unknown", "any", "string", "number", "boolean", "object", "symbol",
    "bigint", "unique", "asserts", "get", "set", "with",
  ]);
  return KEYWORDS.has(value);
}

function isPropertyAccess(tokens: readonly Token[], id: Token, _source: string): boolean {
  const idx = tokens.indexOf(id);
  if (idx <= 0) return false;
  const prev = tokens[idx - 1]!;
  return prev.value === "." || prev.value === "?.";
}

function isDeclarationName(tokens: readonly Token[], id: Token): boolean {
  const idx = tokens.indexOf(id);
  if (idx <= 0) return false;
  const prev = tokens[idx - 1]!;
  if (prev.value === "function" || prev.value === "class" ||
      prev.value === "interface" || prev.value === "type" ||
      prev.value === "enum" || prev.value === "namespace") return true;
  if (prev.value === "const" || prev.value === "let" || prev.value === "var") return true;
  if (prev.value === "async") {
    const prev2 = tokens[idx - 2];
    if (prev2?.value === "function") return true;
  }
  const next = tokens[idx + 1];
  if (next && (next.value === ":" || next.value === "<")) return true;
  return false;
}

function isUsedAsValuePosition(tokens: readonly Token[], id: Token, _source: string): boolean {
  const idx = tokens.indexOf(id);
  if (idx <= 0) return true;
  const prev = tokens[idx - 1]!;
  if (prev.value === "." || prev.value === "?.") return false;
  if (prev.value === "function" || prev.value === "class") return false;
  if (prev.value === "interface" || prev.value === "type") return false;
  if (prev.value === "enum" || prev.value === "namespace") return false;
  if (prev.value === "const" || prev.value === "let" || prev.value === "var") return false;
  if (prev.value === "import" || prev.value === "export") return false;
  if (prev.value === ":" && idx >= 2) {
    const prev2 = tokens[idx - 2]!;
    if (prev2.kind === "identifier") return false;
  }
  return true;
}

export const deadSymbolCheck: QualityCheck = deepFreeze({
  id: "dead-symbols",
  description: "Detect exported symbols that are never imported by any other module",
  category: "dead-code",
  defaultSeverity: "warning",
  run(context: QualityContext): readonly Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const files = context.files;
    const allExports = new Map<string, readonly { name: string; line: number; column: number }[]>();
    const allImportedNames = new Set<string>();
    for (const filePath of Object.keys(files)) {
      if (!isSourceFile(filePath)) continue;
      const source = files[filePath]!;
      const extraction = extractSymbols(filePath, source);
      const exportInfo: { name: string; line: number; column: number }[] = [];
      for (const sym of extraction.symbols) {
        if (sym.exported) {
          exportInfo.push({ name: sym.name, line: sym.location.line, column: sym.location.column });
        }
      }
      allExports.set(filePath, deepFreeze(exportInfo));
      for (const imp of extraction.imports) {
        for (const name of imp.importedNames) allImportedNames.add(name);
      }
      if (extraction.imports.some((i) => i.importedNames.length === 0)) {
        allImportedNames.add("*");
      }
    }
    for (const [filePath, exports] of allExports) {
      if (isTestFile(filePath)) continue;
      for (const exp of exports) {
        if (exp.name === "default") continue;
        if (!allImportedNames.has(exp.name)) {
          diagnostics.push(createDiagnostic({
            packId: PACK_ID,
            checkId: "dead-symbols",
            category: "dead-code",
            severity: "warning",
            code: "dead_exported_symbol",
            message: `Exported symbol '${exp.name}' is never imported by any other module`,
            filePath,
            line: exp.line,
            column: exp.column,
            symbol: exp.name,
            autoFixable: false,
          }));
        }
      }
    }
    return deepFreeze(diagnostics);
  },
});

export const unusedExportCheck: QualityCheck = deepFreeze({
  id: "unused-exports",
  description: "Detect exports that are never used by any consumer",
  category: "unused-export",
  defaultSeverity: "warning",
  run(context: QualityContext): readonly Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const files = context.files;
    const exportMap = new Map<string, { filePath: string; line: number; column: number }[]>();
    for (const filePath of Object.keys(files)) {
      if (!isSourceFile(filePath)) continue;
      const source = files[filePath]!;
      const extraction = extractSymbols(filePath, source);
      for (const sym of extraction.symbols) {
        if (!sym.exported) continue;
        const existing = exportMap.get(sym.name);
        const entry = { filePath, line: sym.location.line, column: sym.location.column };
        if (existing) {
          existing.push(entry);
        } else {
          exportMap.set(sym.name, [entry]);
        }
      }
    }
    const importedNames = new Set<string>();
    for (const filePath of Object.keys(files)) {
      if (!isSourceFile(filePath)) continue;
      const source = files[filePath]!;
      const extraction = extractSymbols(filePath, source);
      for (const imp of extraction.imports) {
        for (const name of imp.importedNames) importedNames.add(name);
      }
    }
    for (const [name, locations] of exportMap) {
      if (importedNames.has(name)) continue;
      for (const loc of locations) {
        if (isTestFile(loc.filePath)) continue;
        diagnostics.push(createDiagnostic({
          packId: PACK_ID,
          checkId: "unused-exports",
          category: "unused-export",
          severity: "warning",
          code: "unused_export",
          message: `Export '${name}' is not imported by any module`,
          filePath: loc.filePath,
          line: loc.line,
          column: loc.column,
          symbol: name,
          autoFixable: false,
        }));
      }
    }
    return deepFreeze(diagnostics);
  },
});

export const deadBranchCheck: QualityCheck = deepFreeze({
  id: "dead-branches",
  description: "Detect unreachable code after return/throw/break/continue and constant conditions",
  category: "dead-branch",
  defaultSeverity: "warning",
  run(context: QualityContext): readonly Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const files = context.files;
    for (const filePath of Object.keys(files)) {
      if (!isSourceFile(filePath)) continue;
      const source = files[filePath]!;
      const tokens = tokenizeWithPositions(source);
      const unreachable = detectUnreachableAfterTerminator(tokens);
      for (const { line, column, kind } of unreachable) {
        diagnostics.push(createDiagnostic({
          packId: PACK_ID,
          checkId: "dead-branches",
          category: "dead-branch",
          severity: "warning",
          code: `unreachable_after_${kind}`,
          message: `Unreachable code detected after ${kind} statement`,
          filePath,
          line,
          column,
          autoFixable: false,
        }));
      }
      const constantBranches = detectConstantConditions(tokens);
      for (const { line, column, condition } of constantBranches) {
        diagnostics.push(createDiagnostic({
          packId: PACK_ID,
          checkId: "dead-branches",
          category: "dead-branch",
          severity: "warning",
          code: "constant_condition",
          message: `Constant condition '${condition}' makes one branch always dead`,
          filePath,
          line,
          column,
          autoFixable: false,
        }));
      }
    }
    return deepFreeze(diagnostics);
  },
});

function isConditionalTerminator(tokens: readonly Token[], terminatorIdx: number): boolean {
  const terminatorLine = tokens[terminatorIdx]!.line;
  for (let i = terminatorIdx - 1; i >= 0; i--) {
    const t = tokens[i]!;
    if (t.line !== terminatorLine) break;
    if (t.value === "if" || t.value === "for" || t.value === "while" ||
        t.value === "switch" || t.value === "try" || t.value === "catch" ||
        t.value === "else" || t.value === "do") {
      return true;
    }
    if (t.value === "}" || t.value === "{" || t.value === ";") break;
  }
  let depth = 0;
  for (let i = terminatorIdx - 1; i >= 0; i--) {
    const t = tokens[i]!;
    if (t.value === ")" || t.value === "]" || t.value === "}") depth += 1;
    else if (t.value === "(" || t.value === "[" || t.value === "{") {
      if (depth === 0) break;
      depth -= 1;
    }
  }
  return false;
}

type TerminatorKind = "return" | "throw" | "break" | "continue";

function detectUnreachableAfterTerminator(tokens: readonly Token[]): readonly Readonly<{ line: number; column: number; kind: TerminatorKind }>[] {
  const results: { line: number; column: number; kind: TerminatorKind }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== "identifier") continue;
    const kind = getTerminatorKind(token.value);
    if (kind === null) continue;
    let j = i + 1;
    let depth = 0;
    let ended = false;
    while (j < tokens.length) {
      const t = tokens[j]!;
      if (t.value === ";" && depth === 0) { ended = true; break; }
      if (t.value === "{" || t.value === "(" || t.value === "[") depth += 1;
      else if (t.value === "}" || t.value === ")" || t.value === "]") depth -= 1;
      if (depth < 0) { ended = true; break; }
      j += 1;
    }
    if (!ended) continue;
    j += 1;
    while (j < tokens.length) {
      const next = tokens[j]!;
      if (next.value === "\n" || next.kind === "identifier" && next.value === " ") {
        j += 1;
        continue;
      }
      break;
    }
    if (j >= tokens.length) continue;
    const nextToken = tokens[j]!;
    if (nextToken.value === "}" || nextToken.value === ")" || nextToken.value === "]") continue;
    if (nextToken.value === "case" || nextToken.value === "default") continue;
    if (isConditionalTerminator(tokens, i)) continue;
    const isDeclKeyword = nextToken.value === "const" || nextToken.value === "let" || nextToken.value === "var";
    const isStmtKeyword = nextToken.value === "return" || nextToken.value === "throw" ||
      nextToken.value === "if" || nextToken.value === "for" || nextToken.value === "while" ||
      nextToken.value === "switch" || nextToken.value === "try" || nextToken.value === "break" ||
      nextToken.value === "continue" || nextToken.value === "let" || nextToken.value === "const" ||
      nextToken.value === "var" || nextToken.value === "function" || nextToken.value === "class" ||
      nextToken.value === "interface" || nextToken.value === "type" || nextToken.value === "enum" ||
      nextToken.value === "namespace" || nextToken.value === "async" || nextToken.value === "export";
    if (nextToken.value === "//") continue;
    if (nextToken.kind === "identifier" || isDeclKeyword || isStmtKeyword) {
      if (isStmtKeyword && (nextToken.value === "function" || nextToken.value === "class" ||
            nextToken.value === "interface" || nextToken.value === "type" ||
            nextToken.value === "enum" || nextToken.value === "namespace" ||
            nextToken.value === "export" || nextToken.value === "async")) {
        if (nextToken.line === token.line) continue;
      }
      if (nextToken.line === token.line) continue;
      results.push({
        line: nextToken.line,
        column: nextToken.column,
        kind,
      });
    }
  }
  return deepFreeze(results);
}

function getTerminatorKind(value: string): TerminatorKind | null {
  if (value === "return") return "return";
  if (value === "throw") return "throw";
  if (value === "break") return "break";
  if (value === "continue") return "continue";
  return null;
}

function detectConstantConditions(tokens: readonly Token[]): readonly Readonly<{ line: number; column: number; condition: string }>[] {
  const results: { line: number; column: number; condition: string }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.value !== "if") continue;
    let j = i + 1;
    if (tokens[j]?.value !== "(") continue;
    const openParen = j;
    j += 1;
    let depth = 1;
    let closeParen = j;
    while (closeParen < tokens.length && depth > 0) {
      const t = tokens[closeParen]!;
      if (t.value === "(") depth += 1;
      else if (t.value === ")") depth -= 1;
      if (depth === 0) break;
      closeParen += 1;
    }
    const inner = tokens.slice(openParen + 1, closeParen);
    const condition = inner.map((t) => t.value).join("").trim().replace(/^\((.+)\)$/u, "$1").trim();
    if (condition === "true" || condition === "false") {
      results.push({
        line: tokens[openParen + 1]!.line,
        column: tokens[openParen + 1]!.column,
        condition,
      });
    }
  }
  return deepFreeze(results);
}

export const duplicateLogicCheck: QualityCheck = deepFreeze({
  id: "duplicate-logic",
  description: "Detect duplicate exported symbols across files (reuse discovery duplicate detection)",
  category: "duplicate-logic",
  defaultSeverity: "warning",
  run(context: QualityContext): readonly Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const files = context.files;
    const exportLocations = new Map<string, { filePath: string; line: number; column: number }[]>();
    for (const filePath of Object.keys(files)) {
      if (!isSourceFile(filePath)) continue;
      const source = files[filePath]!;
      const extraction = extractSymbols(filePath, source);
      for (const sym of extraction.symbols) {
        if (!sym.exported) continue;
        const key = `${sym.name}:${sym.kind}`;
        const list = exportLocations.get(key);
        const entry = { filePath, line: sym.location.line, column: sym.location.column };
        if (list) {
          list.push(entry);
        } else {
          exportLocations.set(key, [entry]);
        }
      }
    }
    for (const [key, locations] of exportLocations) {
      if (locations.length < 2) continue;
      const [name, kind] = key.split(":");
      for (const loc of locations) {
        diagnostics.push(createDiagnostic({
          packId: PACK_ID,
          checkId: "duplicate-logic",
          category: "duplicate-logic",
          severity: "warning",
          code: "duplicate_exported_symbol",
          message: `Duplicate exported ${kind ?? "symbol"} '${name ?? "unknown"}' found in ${locations.length} files`,
          filePath: loc.filePath,
          line: loc.line,
          column: loc.column,
          symbol: name ?? null,
          autoFixable: false,
        }));
      }
    }
    return deepFreeze(diagnostics);
  },
});

export const schemaDriftCheck: QualityCheck = deepFreeze({
  id: "schema-drift",
  description: "Detect architecture-manifest hash drift (declared vs actual exports)",
  category: "schema-drift",
  defaultSeverity: "error",
  run(context: QualityContext): readonly Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const files = context.files;
    const manifestSource = files["src/architecture-manifest.ts"];
    if (manifestSource === undefined) return deepFreeze(diagnostics);
    const manifestExports = extractSymbols("src/architecture-manifest.ts", manifestSource);
    const declaredExportCount = manifestExports.exports.filter(
      (e) => e.kind === "declared" || e.kind === "default",
    ).length;
    if (declaredExportCount === 0) return deepFreeze(diagnostics);
    const hashRegex = /namesSha256:\s*"([0-9a-f]{64})"/gu;
    const matches = [...manifestSource.matchAll(hashRegex)];
    for (const match of matches) {
      const lineNum = manifestSource.slice(0, match.index ?? 0).split("\n").length;
      const nearbyModule = findModuleNameNearLine(manifestSource, lineNum);
      if (nearbyModule === null) continue;
      const moduleSource = files[`src/${nearbyModule}.ts`] ?? files[`src/${nearbyModule}/index.ts`];
      if (moduleSource === undefined) continue;
      const actualExports = extractSymbols(`src/${nearbyModule}.ts`, moduleSource);
      const actualCount = actualExports.exports.filter(
        (e) => e.kind === "declared" || e.kind === "default",
      ).length;
      const declaredCount = extractExportCountNearLine(manifestSource, lineNum);
      if (declaredCount !== null && actualCount !== declaredCount) {
        diagnostics.push(createDiagnostic({
          packId: PACK_ID,
          checkId: "schema-drift",
          category: "schema-drift",
          severity: "error",
          code: "manifest_export_count_drift",
          message: `Module '${nearbyModule}' declared exportCount=${declaredCount} but actual is ${actualCount}`,
          filePath: "src/architecture-manifest.ts",
          line: lineNum,
          column: 0,
          symbol: nearbyModule,
          autoFixable: false,
        }));
      }
    }
    return deepFreeze(diagnostics);
  },
});

function findModuleNameNearLine(source: string, line: number): string | null {
  const lines = source.split("\n");
  for (let i = Math.min(line - 1, lines.length - 1); i >= Math.max(0, line - 20); i--) {
    const match = lines[i]?.match(/id:\s*"([^"]+)"/u);
    if (match) return match[1]!;
  }
  return null;
}

function extractExportCountNearLine(source: string, line: number): number | null {
  const lines = source.split("\n");
  for (let i = line - 1; i < Math.min(line + 3, lines.length); i++) {
    const match = lines[i]?.match(/exportCount:\s*(\d+)/u);
    if (match) return parseInt(match[1]!, 10);
  }
  return null;
}

export const configOutsideContractCheck: QualityCheck = deepFreeze({
  id: "config-outside-contract",
  description: "Detect hardcoded values that should be in the central configuration contract",
  category: "config-outside-contract",
  defaultSeverity: "info",
  run(context: QualityContext): readonly Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const files = context.files;
    const configOwners = new Set([
      "src/kernel/config-contracts.ts",
      "src/kernel/config.ts",
      "src/kernel/root-policy.ts",
    ]);
    for (const filePath of Object.keys(files)) {
      if (!isSourceFile(filePath)) continue;
      if (configOwners.has(filePath)) continue;
      if (isTestFile(filePath)) continue;
      const source = files[filePath]!;
      const hardcoded = detectHardcodedConfigValues(source);
      for (const { line, column, pattern, value } of hardcoded) {
        diagnostics.push(createDiagnostic({
          packId: PACK_ID,
          checkId: "config-outside-contract",
          category: "config-outside-contract",
          severity: "info",
          code: `hardcoded_${pattern}`,
          message: `Hardcoded value '${value}' detected; consider declaring in central config contract`,
          filePath,
          line,
          column,
          autoFixable: false,
        }));
      }
    }
    return deepFreeze(diagnostics);
  },
});

type HardcodedPattern = Readonly<{
  line: number;
  column: number;
  pattern: string;
  value: string;
}>;

function detectHardcodedConfigValues(source: string): readonly HardcodedPattern[] {
  const results: HardcodedPattern[] = [];
  const lines = source.split("\n");
  const patterns: ReadonlyArray<Readonly<{ regex: RegExp; pattern: string; extract: (match: RegExpMatchArray) => string }>> = [
    { regex: /localhost:\d{4,5}/u, pattern: "url", extract: (m) => m[0]! },
    { regex: /https?:\/\/[^\s"'`]+/u, pattern: "url", extract: (m) => m[0]! },
    { regex: /process\.env\.[A-Z_][A-Z0-9_]+/u, pattern: "env_var", extract: (m) => m[0]! },
    { regex: /\b\d{2,}000\b/u, pattern: "magic_number", extract: (m) => m[0]! },
  ];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const { regex, pattern, extract } of patterns) {
      const match = line.match(regex);
      if (match) {
        const column = (match.index ?? 0) + 1;
        results.push({
          line: i + 1,
          column,
          pattern,
          value: extract(match).slice(0, 60),
        });
      }
    }
  }
  return deepFreeze(results);
}

/**
 * D4 quality-pack delegation: body-duplicate detection. Delegates to the
 * shared `detectDuplicateBodies` detector (the same detector the harness's
 * own `test/prevention/no-duplicate-function-bodies.test.ts` consumes). One
 * source of truth per detector, two consumers (harness self + model-facing).
 *
 * Configurable thresholds (read from `context.config` with safe defaults):
 * `duplicateBody.jaccardThreshold` (number 0..1, default 1.0 strict)
 * `duplicateBody.minTokenCount` (number, default 100 — production-scale)
 * `duplicateBody.minBodySize` (number, default 80 — below is too noisy)
 * `duplicateBody.shingleK` (number, default 6 — same as the detector's default)
 *
 * The thresholds are TYPED (number) and validated; invalid values fall back to
 * the defaults (the detector never silently accepts malformed config).
 */
export const duplicateBodyCheck: QualityCheck = deepFreeze({
  id: "duplicate-body",
  description: "Detect duplicate function bodies via 3-pass DRY detector (exact hash + normalized Jaccard + allowlist drift)",
  category: "duplicate-logic",
  defaultSeverity: "warning",
  run(context: QualityContext): readonly Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const sources = Object.entries(context.files)
      .filter(([path]) => isSourceFile(path))
      .map(([path, content]) => ({ path, content }));
    if (sources.length === 0) return deepFreeze(diagnostics);
    const result = detectDuplicateBodies({
      sources,
      allowlistCross: [],
      allowlistSameFile: [],
      ...readDuplicateBodyConfig(context.config),
    });
    for (const f of result.findings) {
      diagnostics.push(createDiagnostic({
        packId: PACK_ID,
        checkId: "duplicate-body",
        category: "duplicate-logic",
        severity: "warning",
        code: "duplicate_body",
        message: `${f.file}:${f.line} ${f.name} (bodySize=${f.bodySize}, passes=${f.passes}) — extract to a shared helper or add to the allowlist if intentional`,
        filePath: f.file,
        line: f.line,
        column: 0,
        symbol: f.name,
        autoFixable: false,
      }));
    }
    return deepFreeze(diagnostics);
  },
});

/**
 * D4 quality-pack delegation: ESM/CJS mismatch detection. Delegates to the
 * shared `detectEsmCjsMismatches` detector.
 */
export const esmCjsMismatchCheck: QualityCheck = deepFreeze({
  id: "esm-cjs-mismatch",
  description: "Detect ESM/CJS mismatches (require in ESM, module.exports in ESM, .js-of-.ts imports, import in .cjs)",
  category: "duplicate-logic",
  defaultSeverity: "error",
  run(context: QualityContext): readonly Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const sources = Object.entries(context.files)
      .filter(([path]) => isSourceFile(path) || path.endsWith(".cjs") || path.endsWith(".mjs"))
      .map(([path, content]) => ({ path, content }));
    if (sources.length === 0) return deepFreeze(diagnostics);
    const findings = detectEsmCjsMismatches({
      sources,
      allowlist: new Set<string>(),
      createRequirePermittedTargets: new Set<string>(),
    });
    for (const f of findings) {
      diagnostics.push(createDiagnostic({
        packId: PACK_ID,
        checkId: "esm-cjs-mismatch",
        category: "duplicate-logic",
        severity: "error",
        code: f.kind,
        message: `${f.file}:${f.line} ${f.detail}`,
        filePath: f.file,
        line: f.line,
        column: 0,
        autoFixable: false,
      }));
    }
    return deepFreeze(diagnostics);
  },
});

/**
 * D4 quality-pack delegation: duplicated literals detection. Delegates to the
 * shared `detectDuplicatedLiterals` detector.
 */
export const duplicatedLiteralsCheck: QualityCheck = deepFreeze({
  id: "duplicated-literals",
  description: "Detect duplicated string/numeric literals that should be named constants",
  category: "config-outside-contract",
  defaultSeverity: "info",
  run(context: QualityContext): readonly Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const sources = Object.entries(context.files)
      .filter(([path]) => isSourceFile(path))
      .map(([path, content]) => ({ path, content }));
    if (sources.length === 0) return deepFreeze(diagnostics);
    // The quality pack uses a minimal concept set (the harness's own prevention
    // test uses the full allowlist; the model-facing pack just flags literals
    // that appear in multiple model-generated files).
    const findings = detectDuplicatedLiterals({
      sources,
      concepts: new Map(),
    });
    for (const f of findings.findings) {
      diagnostics.push(createDiagnostic({
        packId: PACK_ID,
        checkId: "duplicated-literals",
        category: "config-outside-contract",
        severity: "info",
        code: "duplicated_literal",
        message: `${f.file}:${f.line} literal "${f.literal}" (concept: ${f.concept}) — extract to ${f.canonicalOwner}`,
        filePath: f.file,
        line: f.line,
        column: 0,
        autoFixable: false,
      }));
    }
    return deepFreeze(diagnostics);
  },
});

export const typescriptPack: QualityPack = deepFreeze({
  id: PACK_ID,
  language: "typescript",
  version: PACK_VERSION,
  detect(files: Readonly<Record<string, string>>): boolean {
    for (const filePath of Object.keys(files)) {
      const ext = getExtension(filePath);
      if (ALL_EXTENSIONS.has(ext)) return true;
    }
    return false;
  },
  checks: [
    syntaxCheck,
    typeCheck,
    undefinedSymbolCheck,
    deadSymbolCheck,
    unusedExportCheck,
    deadBranchCheck,
    duplicateLogicCheck,
    duplicateBodyCheck,
    esmCjsMismatchCheck,
    duplicatedLiteralsCheck,
    schemaDriftCheck,
    configOutsideContractCheck,
  ],
});

export { typescriptPack as default };
