import { parse as parseTypeScriptAst } from "@babel/parser";

import { extractErrorMessage, InputError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import { JS_EXTENSIONS, TS_EXTENSIONS } from "../kernel/language-extensions.ts";
import {
  getLanguageByExtension,
  getTreeSitterLanguages,
  type LanguageSpec,
} from "../intelligence/language-registry.ts";
import { initTreeSitterBackend, isLanguageReady, parseSync } from "../intelligence/tree-sitter-backend.ts";
import { extractExtension } from "../shared/path-utils.ts";

/**
 * Syntax validator for the transactional editor.
 *
 * Per delivery map item 8 and REQ-023: "Never apply
 * syntax/name/type/indentation/punctuation mistakes for supported languages,
 * even when textual matching succeeds."
 *
 * For TS/JS: parse with Babel (the existing AST infrastructure already used
 * in `scripts/verification/static-source.ts` and `scripts/test-inventory.ts`).
 * For JSON: parse with `JSON.parse`.
 * For other file types: configurable via a pluggable validator registry.
 *
 * Syntax errors are reported with line/column for feedback to the model.
 */

export type SyntaxDiagnosticSeverity = "error" | "warning";

export type SyntaxDiagnostic = Readonly<{
  severity: SyntaxDiagnosticSeverity;
  line: number;
  column: number;
  message: string;
  code: string;
}>;

export type SyntaxValidationResult = Readonly<{
  valid: boolean;
  language: string;
  diagnostics: readonly SyntaxDiagnostic[];
}>;

export type SyntaxValidatorFn = (content: string) => SyntaxValidationResult;

export type SyntaxValidatorRegistry = Readonly<{
  register(extension: string, validator: SyntaxValidatorFn): void;
  get(extension: string): SyntaxValidatorFn | undefined;
  supportedExtensions(): readonly string[];
}>;

const BABEL_PLUGINS = [
  "typescript",
  "jsx",
  "objectRestSpread",
  "classProperties",
  "classPrivateProperties",
  "classPrivateMethods",
  "dynamicImport",
  "numericSeparator",
  "optionalChaining",
  "optionalCatchBinding",
  "nullishCoalescingOperator",
  "asyncGenerators",
  "decorators-legacy",
  "exportDefaultFrom",
  "exportNamespaceFrom",
] as const;

const JSON_EXTENSIONS = new Set([".json"]);

export function createSyntaxValidatorRegistry(): SyntaxValidatorRegistry {
  const validators = new Map<string, SyntaxValidatorFn>();
  return deepFreeze({
    register(extension: string, validator: SyntaxValidatorFn): void {
      const key = normalizeExtension(extension);
      if (typeof validator !== "function") {
        throw new InputError("Syntax validator must be a function", "syntax_validator_invalid");
      }
      validators.set(key, validator);
    },
    get(extension: string): SyntaxValidatorFn | undefined {
      return validators.get(normalizeExtension(extension));
    },
    supportedExtensions(): readonly string[] {
      return [...validators.keys()].sort();
    },
  });
}

export function createDefaultSyntaxValidatorRegistry(): SyntaxValidatorRegistry {
  const registry = createSyntaxValidatorRegistry();
  for (const ext of TS_EXTENSIONS) {
    registry.register(ext, (content) => validateTypeScript(content, "module", true));
  }
  for (const ext of JS_EXTENSIONS) {
    registry.register(ext, (content) => validateTypeScript(content, "module", false));
  }
  for (const ext of JSON_EXTENSIONS) {
    registry.register(ext, validateJson);
  }
  registerTreeSitterValidators(registry);
  return registry;
}

/**
 * Register a syntax validator for every tree-sitter-backed language. The
 * validator parses the source with tree-sitter and reports syntax errors
 * (nodes with `hasError === true` or `ERROR`/`MISSING` node types).
 *
 * Requires `await initTreeSitterBackend([...])` to have been awaited for
 * the languages first; languages whose grammar is not yet loaded are
 * skipped (honest degradation — the registry only registers validators
 * that can actually run). Call `await initTreeSitterSyntaxValidators`
 * before constructing a registry that needs full multi-language support.
 */
function registerTreeSitterValidators(registry: SyntaxValidatorRegistry): SyntaxValidatorRegistry {
  for (const spec of getTreeSitterLanguages()) {
    if (!isLanguageReady(spec.id)) continue;
    for (const ext of spec.extensions) {
      if (registry.get(ext) === undefined) {
        registry.register(ext, (content) => validateTreeSitter(spec, content));
      }
    }
  }
  return registry;
}

/**
 * Preload tree-sitter grammars for every language marked
 * `treeSitter: true` in the registry. Await this once before building a
 * registry with `createLanguageAgnosticSyntaxValidatorRegistry` so
 * `registerTreeSitterValidators` finds ready languages.
 */
export async function initTreeSitterSyntaxValidators(): Promise<void> {
  const langs = getTreeSitterLanguages().map((spec) => spec.id);
  await initTreeSitterBackend(langs);
}

/** Build a registry that validates EVERY registered language. */
export async function createLanguageAgnosticSyntaxValidatorRegistry(): Promise<SyntaxValidatorRegistry> {
  await initTreeSitterSyntaxValidators();
  return createDefaultSyntaxValidatorRegistry();
}

function validateTreeSitter(spec: LanguageSpec, content: string): SyntaxValidationResult {
  let handle;
  try {
    handle = parseSync(spec.id, content);
  } catch (error) {
    return deepFreeze({
      valid: false,
      language: spec.id,
      diagnostics: [deepFreeze({
        severity: "error" as const,
        line: 0,
        column: 0,
        message: extractErrorMessage(error),
        code: "syntax_tree_sitter_parse_failed",
      })],
    });
  }
  if (handle === null) {
    return deepFreeze({
      valid: false,
      language: spec.id,
      diagnostics: [deepFreeze({
        severity: "error" as const,
        line: 0,
        column: 0,
        message: "tree-sitter returned no parse tree",
        code: "syntax_tree_sitter_no_tree",
      })],
    });
  }
  try {
    // Native descendantsOfType — no JS recursion (avoids stack overflow on
    // large files), no `.text` reads (avoids WASM-OOM). We only need
    // ERROR/MISSING node positions.
    const errorNodes = handle.root.descendantsOfType(["ERROR", "MISSING"]);
    const diagnostics: SyntaxDiagnostic[] = [];
    for (const node of errorNodes) {
      if (diagnostics.length >= 50) break;
      diagnostics.push(deepFreeze({
        severity: "error" as const,
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
        message: node.type === "MISSING" ? "missing syntax node" : "syntax error",
        code: "syntax_tree_sitter_parse_error",
      }));
    }
    return deepFreeze({
      valid: diagnostics.length === 0,
      language: spec.id,
      diagnostics: deepFreeze(diagnostics),
    });
  } finally {
    handle.done();
  }
}

export function detectLanguage(filePath: string): string {
  const lang = getLanguageByExtension(filePath);
  if (lang !== undefined) return lang.id;
  const ext = extractExtension(filePath);
  if (JSON_EXTENSIONS.has(ext)) return "json";
  return "unknown";
}

export function validateSyntax(
  filePath: string,
  content: string,
  registry: SyntaxValidatorRegistry,
  options?: Readonly<{ skipUnknown?: boolean }>,
): SyntaxValidationResult {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new InputError("File path is required for syntax validation", "syntax_validator_path_empty");
  }
  if (typeof content !== "string") {
    throw new InputError("Content must be a string for syntax validation", "syntax_validator_content_invalid");
  }
  const ext = extractExtension(filePath);
  const language = detectLanguage(filePath);
  const validator = registry.get(ext);
  if (validator === undefined) {
    if (options?.skipUnknown === true) {
      return deepFreeze({
        valid: true,
        language,
        diagnostics: [],
      });
    }
    return deepFreeze({
      valid: false,
      language: "unknown",
      diagnostics: [deepFreeze({
        severity: "error",
        line: 0,
        column: 0,
        message: `No syntax validator registered for extension '${ext}'`,
        code: "syntax_validator_unsupported_extension",
      })],
    });
  }
  return validator(content);
}

function validateTypeScript(content: string, sourceType: "module" | "script", isTypeScript: boolean): SyntaxValidationResult {
  const plugins: readonly string[] = isTypeScript
    ? ["typescript", ...BABEL_PLUGINS.filter((p) => p !== "typescript")]
    : [...BABEL_PLUGINS.filter((p) => p !== "typescript")];
  try {
    parseTypeScriptAst(content, {
      sourceType,
      plugins: [...plugins] as never,
      errorRecovery: false,
    });
    return deepFreeze({
      valid: true,
      language: isTypeScript ? "typescript" : "javascript",
      diagnostics: [],
    });
  } catch (error) {
    const diagnostics = extractBabelDiagnostics(error);
    return deepFreeze({
      valid: false,
      language: isTypeScript ? "typescript" : "javascript",
      diagnostics,
    });
  }
}

function validateJson(content: string): SyntaxValidationResult {
  try {
    JSON.parse(content);
    return deepFreeze({
      valid: true,
      language: "json",
      diagnostics: [],
    });
  } catch (error) {
    const pos = extractJsonErrorPosition(error, content);
    return deepFreeze({
      valid: false,
      language: "json",
      diagnostics: [deepFreeze({
        severity: "error" as const,
        line: pos.line,
        column: pos.column,
        message: extractErrorMessage(error),
        code: "syntax_json_parse_error",
      })],
    });
  }
}

function extractBabelDiagnostics(error: unknown): readonly SyntaxDiagnostic[] {
  const diagnostics: SyntaxDiagnostic[] = [];
  if (error !== null && typeof error === "object") {
    const maybeErrors = (error as { errors?: unknown }).errors;
    if (Array.isArray(maybeErrors)) {
      for (const e of maybeErrors) {
        diagnostics.push(babelErrorToDiagnostic(e));
      }
    } else {
      diagnostics.push(babelErrorToDiagnostic(error));
    }
  }
  return deepFreeze(diagnostics);
}

function babelErrorToDiagnostic(error: unknown): SyntaxDiagnostic {
  if (error !== null && typeof error === "object") {
    const loc = (error as { loc?: { line?: number; column?: number } }).loc;
    const code = (error as { code?: string }).code;
    return deepFreeze({
      severity: "error" as const,
      line: loc?.line ?? 0,
      column: loc?.column ?? 0,
      message: (error as { message?: string }).message ?? String(error),
      code: code ?? "syntax_babel_error",
    });
  }
  return deepFreeze({
    severity: "error" as const,
    line: 0,
    column: 0,
    message: String(error),
    code: "syntax_babel_error",
  });
}

function extractJsonErrorPosition(error: unknown, content: string): Readonly<{ line: number; column: number }> {
  const message = extractErrorMessage(error);
  const positionMatch = message.match(/position\s+(\d+)/u);
  if (positionMatch === null) return { line: 0, column: 0 };
  const offset = Number.parseInt(positionMatch[1]!, 10);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > content.length) {
    return { line: 0, column: 0 };
  }
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

function normalizeExtension(extension: string): string {
  if (extension.length === 0) return "";
  return extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
}
