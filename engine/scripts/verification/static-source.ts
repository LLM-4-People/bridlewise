import { ARCHITECTURE_SOURCE_EXTENSIONS } from "../../src/shared/source-extensions.ts";
import { isPlainObject } from "../../src/shared/type-guards.ts";
import { deepFreeze, sha256 } from "../../src/kernel/integrity.ts";
import { DEFAULT_STATIC_MODULE_SHAPE_CACHE_MAX_ENTRIES } from "../../src/workflow/workflow-config.ts";

const MODULE_ACQUISITION_KINDS = ["direct-import", "re-export", "dynamic-import", "require"] as const;
const ENVIRONMENT_ACQUISITION_FORMS = ["process.env.NAME", "process.env['NAME']", "process['env']"] as const;

export type ModuleAcquisition = Readonly<{
  kind: typeof MODULE_ACQUISITION_KINDS[number];
  specifier: string | null;
}>;

export type EnvironmentAcquisition = Readonly<{
  form: typeof ENVIRONMENT_ACQUISITION_FORMS[number];
  name: string | null;
}>;

export type StaticSourceAnalysis = Readonly<{
  moduleAcquisitions: readonly ModuleAcquisition[];
  typeOnlyModuleReferences: readonly string[];
  unmodeledModuleAcquisition: boolean;
  environmentAcquisitions: readonly EnvironmentAcquisition[];
  unmodeledEnvironmentAccess: boolean;
}>;

export type StaticModuleShape = Readonly<{
  exportedNames: readonly string[];
  analysis: StaticSourceAnalysis;
}>;

type Token = Readonly<{
  kind: "identifier" | "punctuation" | "string" | "template";
  value: string;
  start: number;
}>;

/**
 * Deliberately small lexical oracle. It shares no parser or evaluator with the
 * Babel architecture analyzer, so disagreements expose different false-green
 * modes and fail closed in the architecture verifier.
 */
export function analyzeStaticSource(source: string, sourcePath: string): StaticSourceAnalysis {
  if (typeof source !== "string" || typeof sourcePath !== "string") {
    return deepFreeze({
      moduleAcquisitions: [],
      typeOnlyModuleReferences: [],
      unmodeledModuleAcquisition: true,
      environmentAcquisitions: [],
      unmodeledEnvironmentAccess: true,
    });
  }
  const jsx = sourceUsesJsx(sourcePath);
  return analyzeStaticTokens(tokenizeSource(source, jsx), source, jsx);
}

function analyzeStaticTokens(tokens: readonly Token[], source: string, jsx: boolean): StaticSourceAnalysis {
  const moduleLoaderAliases = new Set(["require"]);
  for (let index = 2; index < tokens.length; index += 1) {
    if (tokens[index]?.kind === "identifier" && tokens[index]?.value === "createRequire" &&
      tokens[index + 1]?.value === "(" && tokens[index - 1]?.value === "=" &&
      tokens[index - 2]?.kind === "identifier") {
      moduleLoaderAliases.add(tokens[index - 2]!.value);
    }
  }
  const moduleAcquisitions: ModuleAcquisition[] = [];
  const typeOnlyModuleReferences: string[] = [];
  const pairs = tokenDelimiterPairs(tokens);
  const typeContext = erasedTypeTokens(tokens, source, pairs, jsx);
  const erased = typeContext.erased;
  let unmodeledModuleAcquisition = typeContext.unsupported;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind === "template" && /\b(?:import|require)\s*\(/u.test(token.value)) {
      moduleAcquisitions.push({ kind: "dynamic-import", specifier: null });
    }
    if (token.kind !== "identifier") continue;
    if (token.value === "import" && tokens[index - 1]?.kind === "punctuation" &&
      [".", "?."].includes(tokens[index - 1]?.value ?? "")) continue;
    if (token.value === "import" && tokens[index + 1]?.kind === "punctuation" &&
      (tokens[index + 1]?.value === ":" ||
        (tokens[index + 1]?.value === "?" && tokens[index + 2]?.value === ":"))) continue;
    if ((token.value === "import" || moduleLoaderAliases.has(token.value)) && tokens[index + 1]?.value === "(") {
      const argument = tokens[index + 2];
      const close = tokens[index + 3];
      if (erased.has(index)) {
        if (argument?.kind === "string") typeOnlyModuleReferences.push(argument.value);
        else unmodeledModuleAcquisition = true;
      } else {
        moduleAcquisitions.push({
          kind: token.value === "import" ? "dynamic-import" : "require",
          specifier: argument?.kind === "string" && (close?.value === ")" || close?.value === ",") ? argument.value : null,
        });
      }
      continue;
    }
    if (moduleLoaderAliases.has(token.value) && tokens[index + 1]?.value !== "=") {
      unmodeledModuleAcquisition = true;
      continue;
    }
    if (token.value === "import") {
      if (tokens[index + 1]?.value === "." && tokens[index + 2]?.value === "meta") continue;
      const explicitType = tokens[index + 1]?.value === "type" &&
        !["from", ",", "="].includes(tokens[index + 2]?.value ?? "");
      const typeDeclaration = erased.has(index) || explicitType;
      const alias = index + (explicitType ? 2 : 1);
      if (tokens[alias]?.kind === "identifier" && tokens[alias + 1]?.value === "=") {
        if (!typeDeclaration) unmodeledModuleAcquisition = true;
        const literal = tokens[alias + 4];
        if (typeDeclaration && tokens[alias + 2]?.value === "require" && tokens[alias + 3]?.value === "(" && literal?.kind === "string" && tokens[alias + 5]?.value === ")") {
          typeOnlyModuleReferences.push(literal.value);
          index = alias + 5;
        }
        continue;
      }
      const direct = tokens[index + 1];
      if (direct?.kind === "string") {
        if (typeDeclaration) typeOnlyModuleReferences.push(direct.value);
        else moduleAcquisitions.push({ kind: "direct-import", specifier: direct.value });
        continue;
      }
      let cursor = alias;
      if (tokens[cursor]?.kind === "identifier") {
        cursor += 1;
        if (tokens[cursor]?.value === ",") cursor += 1;
      }
      if (tokens[cursor]?.value === "*") cursor += tokens[cursor + 1]?.value === "as" ? 3 : 1;
      else if (tokens[cursor]?.value === "{") cursor = (pairs.get(cursor) ?? cursor) + 1;
      if (tokens[cursor]?.kind === "identifier" && tokens[cursor]?.value === "from") {
        const specifier = tokens[cursor + 1]?.kind === "string" ? tokens[cursor + 1]!.value : null;
        if (typeDeclaration && specifier !== null) typeOnlyModuleReferences.push(specifier);
        else moduleAcquisitions.push({ kind: "direct-import", specifier });
        index = cursor + 1;
      } else unmodeledModuleAcquisition = true;
    }
    if (!erased.has(index) && token.value === "export" && tokens[index + 1]?.value === "=") unmodeledModuleAcquisition = true;
    const exportTarget = token.value === "export" && tokens[index + 1]?.value === "type"
      ? tokens[index + 2]?.value
      : tokens[index + 1]?.value;
    if (token.value === "export" && (exportTarget === "*" || exportTarget === "{")) {
      const explicitType = tokens[index + 1]?.value === "type";
      const typeDeclaration = erased.has(index) || explicitType;
      let cursor = index + (explicitType ? 2 : 1);
      if (exportTarget === "*") {
        cursor += 1;
        if (tokens[cursor]?.value === "as") cursor += 2;
      } else cursor = (pairs.get(cursor) ?? cursor) + 1;
      if (tokens[cursor]?.kind === "identifier" && tokens[cursor]?.value === "from") {
        const specifier = tokens[cursor + 1]?.kind === "string" ? tokens[cursor + 1]!.value : null;
        if (typeDeclaration && specifier !== null) typeOnlyModuleReferences.push(specifier);
        else moduleAcquisitions.push({ kind: "re-export", specifier });
        index = cursor + 1;
      } else {
        if (exportTarget === "*") unmodeledModuleAcquisition = true;
        index = cursor - 1;
      }
    }
  }
  const environment = analyzeEnvironmentAcquisitions(tokens.filter((_, index) => !erased.has(index)));
  return deepFreeze({ moduleAcquisitions, typeOnlyModuleReferences, unmodeledModuleAcquisition, ...environment });
}

function tokenDelimiterPairs(tokens: readonly Token[]): ReadonlyMap<number, number> {
  const pairs = new Map<number, number>();
  const opens: number[] = [];
  const closeFor: Readonly<Record<string, string>> = { "(": ")", "[": "]", "{": "}" };
  for (let index = 0; index < tokens.length; index += 1) {
    const current = tokens[index]!.value;
    if (tokens[index]?.kind === "punctuation" && Object.hasOwn(closeFor, current)) opens.push(index);
    else if (tokens[index]?.kind === "punctuation" && [")", "]", "}"].includes(current)) {
      const start = opens.pop();
      if (start !== undefined && closeFor[tokens[start]!.value] === current) pairs.set(start, index);
    }
  }
  return pairs;
}

/**
 * Mark only grammatically anchored erased regions, without parsing expressions.
 * Delimiters keep a type annotation from consuming its initializer/body; all
 * remaining acquisitions stay runtime candidates and disagreement fails closed.
 */
function erasedTypeTokens(tokens: readonly Token[], source: string, pairs: ReadonlyMap<number, number>, jsx: boolean): Readonly<{ erased: ReadonlySet<number>; unsupported: boolean }> {
  let unsupported = false;
  const erased = new Set<number>();
  const value = (index: number): string | undefined => tokens[index]?.kind === "string" || tokens[index]?.kind === "template" ? undefined : tokens[index]?.value;
  const angleEnd = (start: number): number | undefined => {
    let depth = 0;
    for (let index = start; index < tokens.length; index += 1) {
      const current = value(index);
      if (current === "<") depth += 1;
      else if (tokens[index]?.kind === "punctuation" && /^>{1,3}$/u.test(current ?? "")) {
        depth -= current!.length;
        if (depth <= 0) return index;
      }
      const paired = pairs.get(index);
      if (paired !== undefined) index = paired;
    }
    return undefined;
  };
  const mark = (start: number, end: number): void => {
    for (let index = start; index < end; index += 1) erased.add(index);
  };
  const typeEnd = (start: number, stops: readonly string[]): number => {
    let angles = 0;
    for (let index = start; index < tokens.length; index += 1) {
      const current = value(index)!;
      if (angles === 0 && stops.includes(current) && !(index === start && current === "{")) return index;
      const prior = value(index - 1);
      const gap = index > start ? source.slice(tokens[index - 1]!.start + tokens[index - 1]!.value.length, tokens[index]!.start) : "";
      if (index > start && angles === 0 && gap.includes("\n") &&
        tokens[index]?.kind === "identifier" && (["identifier", "string", "template"].includes(tokens[index - 1]?.kind ?? "") || [")", "]", "}", ">", ">>", ">>>"].includes(prior ?? "")) &&
        !["keyof", "typeof", "readonly", "infer", "extends", "is", "in", "new"].includes(prior ?? "") &&
        !["extends", "is"].includes(current)) return index;
      if (index > start && angles === 0 && gap.includes("\n") &&
        ["!", "~", "++", "--", "+", "-", "/regex/"].includes(current)) return index;
      // A new declaration after a line boundary ends a semicolonless type.
      if (index > start && angles === 0 && ["const", "let", "var", "export", "type", "interface", "function", "class", "return"].includes(current) &&
        source.slice(tokens[index - 1]!.start + tokens[index - 1]!.value.length, tokens[index]!.start).includes("\n")) return index;
      if (current === "(" && index > start && prior !== "import" &&
        (tokens[index - 1]?.kind === "identifier" || [")", "]"].includes(prior ?? ""))) return index;
      const paired = pairs.get(index);
      if (paired !== undefined) { index = paired; continue; }
      if (current === "<") angles += 1;
      else if (/^>{1,3}$/u.test(current)) angles = Math.max(0, angles - current.length);
    }
    return tokens.length;
  };
  const markParameters = (start: number, end: number): void => {
    let cursor = start + 1;
    while (cursor < end) {
      if (value(cursor) === "...") cursor += 1;
      const bindingEnd = pairs.get(cursor) ?? cursor;
      cursor = bindingEnd + 1;
      if (value(cursor) === "?") cursor += 1;
      if (value(cursor) === ":") {
        const finish = Math.min(end, typeEnd(cursor + 1, [",", ")", "="]));
        mark(cursor + 1, finish);
        cursor = finish;
      }
      // Default values are expressions, including ternaries. Only a comma
      // outside nested delimiters can begin the next parameter binding.
      while (cursor < end && value(cursor) !== ",") cursor = (pairs.get(cursor) ?? cursor) + 1;
      cursor += 1;
    }
  };
  for (let index = 0; index < tokens.length; index += 1) {
    if (erased.has(index)) continue;
    const current = value(index);
    if ((current === "declare" || (current === "module" && tokens[index + 1]?.kind === "string")) && tokens[index]?.kind === "identifier" &&
      ![".", "?."].includes(value(index - 1) ?? "")) {
      const declaration = current === "declare" ? value(index + 1) : "module";
      if (["module", "namespace", "global", "class", "enum", "interface"].includes(declaration ?? "")) {
        let cursor = index + 2;
        if (declaration === "global") cursor = index + 1;
        while (cursor < tokens.length && !["{", ";"].includes(value(cursor) ?? "")) {
          cursor = (value(cursor) === "<" ? angleEnd(cursor) : pairs.get(cursor)) ?? cursor;
          cursor += 1;
        }
        const end = pairs.get(cursor);
        if (end !== undefined) mark(index, end + 1);
      } else if (["const", "let", "var", "function"].includes(declaration ?? "")) {
        mark(index, typeEnd(index + 2, [";", "}"]));
      }
      continue;
    }
    if (current === "function") {
      let cursor = index + 1;
      if (value(cursor) === "*") cursor += 1;
      if (tokens[cursor]?.kind === "identifier") cursor += 1;
      if (value(cursor) === "<") {
        const end = angleEnd(cursor);
        if (end !== undefined) { mark(cursor, end + 1); cursor = end + 1; }
      }
      const end = value(cursor) === "(" ? pairs.get(cursor) : undefined;
      if (end !== undefined) {
        markParameters(cursor, end);
        if (value(end + 1) === ":") mark(end + 2, typeEnd(end + 2, ["{", ";"]));
      }
    }
    if (current === "<" && ["=", "(", "[", "{", ",", ":", "?", "return", "=>"].includes(value(index - 1) ?? "")) {
      const end = angleEnd(index);
      let arrow = false;
      const parameters = end === undefined ? undefined : pairs.get(end + 1);
      if (parameters !== undefined && value(end! + 1) === "(") {
        const after = value(parameters + 1);
        const returnEnd = after === ":" ? typeEnd(parameters + 2, ["=>", ";"]) : parameters + 1;
        if (after === "=>" || (after === ":" && value(returnEnd) === "=>")) {
          arrow = true;
          mark(index, end! + 1);
          markParameters(end! + 1, parameters);
          if (after === ":") mark(parameters + 2, returnEnd);
        }
      }
      if (!jsx && end !== undefined && !arrow) unsupported = true;
    }
    if (current === "type" && tokens[index + 1]?.kind === "identifier" &&
      !["import", "const", "let", "var", ".", "?."].includes(value(index - 1) ?? "")) {
      let cursor = index + 2;
      if (value(cursor) === "<") {
        let depth = 1;
        while (++cursor < tokens.length && depth > 0) {
          if (value(cursor) === "<") depth += 1;
          else if (/^>{1,3}$/u.test(value(cursor) ?? "")) depth -= value(cursor)!.length;
        }
      }
      if (value(cursor) === "=") {
        const end = typeEnd(cursor + 1, [";", "}"]);
        mark(index, end);
        continue;
      }
    }
    if (current === "interface" && tokens[index + 1]?.kind === "identifier") {
      let cursor = index + 2;
      while (cursor < tokens.length && !["{", ";", "="].includes(value(cursor)!)) cursor += 1;
      const end = pairs.get(cursor);
      if (end !== undefined) mark(index, end + 1);
      continue;
    }
    if (["const", "let", "var"].includes(current ?? "") && tokens[index + 1]?.kind === "identifier" && value(index + 2) === ":") {
      mark(index + 3, typeEnd(index + 3, ["=", ",", ";", ")", "}"]));
    }
    if (current === "(") {
      const end = pairs.get(index);
      if (end === undefined) continue;
      const after = value(end + 1);
      const returnEnd = after === ":" ? typeEnd(end + 2, ["{", "=>", ";"]) : end + 1;
      const arrow = after === "=>" || (after === ":" && value(returnEnd) === "=>");
      const namedFunction = value(index - 1) === "function" || value(index - 2) === "function";
      const method = tokens[index - 1]?.kind === "identifier" &&
        ["{", ";", "}", "static", "async", "get", "set"].includes(value(index - 2) ?? "") &&
        ["{", ":"].includes(after ?? "");
      if (arrow || namedFunction || method) {
        markParameters(index, end);
        if (after === ":") mark(end + 2, returnEnd);
      }
    }
    if (current === "class" && tokens[index + 1]?.kind === "identifier") {
      let body = index + 2;
      while (body < tokens.length && !["{", ";"].includes(value(body)!)) body += 1;
      const end = pairs.get(body);
      if (end !== undefined) {
        for (let cursor = body + 1; cursor < end; cursor += 1) {
          const paired = pairs.get(cursor);
          if (paired !== undefined) { cursor = paired; continue; }
          if (tokens[cursor]?.kind !== "identifier" || !["{", ";", "}", "static", "declare", "readonly", "public", "private", "protected"].includes(value(cursor - 1) ?? "")) continue;
          const colon = ["?", "!"].includes(value(cursor + 1) ?? "") ? cursor + 2 : cursor + 1;
          if (value(colon) === ":") mark(colon + 1, typeEnd(colon + 1, ["=", ";", "}"]));
        }
      }
    }
    if (["as", "satisfies"].includes(current ?? "") && value(index + 1) === "import") {
      mark(index + 1, typeEnd(index + 1, [";", ",", ")", "}", "=", "+", "-", "*", "/", "%", "&&", "||", "??", "===", "!==", "==", "!=", "?", ":", "<", ">", "<=", ">=", "**", "in", "instanceof"]));
    }
  }
  return { erased, unsupported };
}

// Content-hash memoization of analyzeStaticModuleShape. The function is a
// pure function of source: it tokenizes + derives StaticModuleShape with no
// side effects. Candidates created by makeRuntimeCandidate share the same
// file contents (copy-on-write reflinks), so a mutated candidate that
// changed only one file hits the cache for every OTHER file. The cache is
// module-level so it persists across verifyS1Structure calls within the same
// process. Bounded by FIFO eviction.
const STATIC_MODULE_SHAPE_CACHE_MAX_ENTRIES = DEFAULT_STATIC_MODULE_SHAPE_CACHE_MAX_ENTRIES;
const staticModuleShapeCache = new Map<string, StaticModuleShape>();

import { createFilesystemCache, analysisSemanticsId } from "./filesystem-cache.ts";
import { DEFAULT_STATIC_MODULE_SHAPE_FILESYSTEM_CACHE_MAX_ENTRIES } from "../../src/workflow/workflow-config.ts";

const staticModuleShapeFilesystemCache = createFilesystemCache({
  directory: "harness-static-cache",
  maxEntries: DEFAULT_STATIC_MODULE_SHAPE_FILESYSTEM_CACHE_MAX_ENTRIES,
});

// Shape keys bind the actual source path, source bytes, scanner bytes and
// shared extension vocabulary. A TS and TSX view cannot share a cached shape.
// Unavailable source identity bypasses both result caches; successful identities
// preserve the existing memory and filesystem warm paths.

function validateStaticModuleShape(value: unknown): StaticModuleShape | undefined {
  if (!isPlainObject(value) || !Array.isArray(value.exportedNames) ||
    !value.exportedNames.every((name) => typeof name === "string") || !isPlainObject(value.analysis)) return undefined;
  const analysis = value.analysis;
  if (!Array.isArray(analysis.typeOnlyModuleReferences) ||
    !analysis.typeOnlyModuleReferences.every((entry) => typeof entry === "string")) return undefined;
  if (typeof analysis.unmodeledModuleAcquisition !== "boolean" ||
    typeof analysis.unmodeledEnvironmentAccess !== "boolean") return undefined;
  if (!Array.isArray(analysis.moduleAcquisitions) || !analysis.moduleAcquisitions.every((entry) =>
    isPlainObject(entry) && (MODULE_ACQUISITION_KINDS as readonly unknown[]).includes(entry.kind) &&
    (entry.specifier === null || typeof entry.specifier === "string"))) return undefined;
  if (!Array.isArray(analysis.environmentAcquisitions) || !analysis.environmentAcquisitions.every((entry) =>
    isPlainObject(entry) && (ENVIRONMENT_ACQUISITION_FORMS as readonly unknown[]).includes(entry.form) &&
    (entry.name === null || typeof entry.name === "string"))) return undefined;
  return value as unknown as StaticModuleShape;
}

export function clearStaticModuleShapeCache(): void {
  staticModuleShapeCache.clear();
}

export function analyzeStaticModuleShape(source: string, sourcePath: string): StaticModuleShape {
  if (typeof source !== "string" || typeof sourcePath !== "string") throw new Error("source and source path must be strings");
  const contentHash = sha256(Buffer.from(source, "utf8"));
  const semanticsId = analysisSemanticsId(import.meta.url, new URL("../../src/shared/source-extensions.ts", import.meta.url));
  const cacheKey = semanticsId === undefined ? undefined : `${sourcePath}\u0000${contentHash}\u0000${semanticsId}`;
  const cached = cacheKey === undefined ? undefined : staticModuleShapeCache.get(cacheKey);
  if (cached !== undefined) return cached;
  // Filesystem-backed cache: shared across serial-phase processes.
  const filesystemCached = cacheKey === undefined ? undefined : staticModuleShapeFilesystemCache.read<StaticModuleShape>(cacheKey, validateStaticModuleShape);
  if (cacheKey !== undefined && filesystemCached !== undefined) {
    staticModuleShapeCache.set(cacheKey, filesystemCached);
    return filesystemCached;
  }
  const jsx = sourceUsesJsx(sourcePath);
  const tokens = tokenizeSource(source, jsx);
  const analysis = analyzeStaticTokens(tokens, source, jsx);
  const exportedNames: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.kind !== "identifier" || tokens[index]?.value !== "export") continue;
    let cursor = index + 1;
    if (tokens[cursor]?.value === "default") {
      exportedNames.push("default");
      continue;
    }
    if (tokens[cursor]?.value === "declare") cursor += 1;
    if (tokens[cursor]?.value === "async") cursor += 1;
    if (tokens[cursor]?.value === "type" && ["{", "*"].includes(tokens[cursor + 1]?.value ?? "")) cursor += 1;
    const form = tokens[cursor]?.value;
    if (form === "import") {
      const alias = tokens[cursor + 1]?.value === "type" ? cursor + 2 : cursor + 1;
      if (tokens[alias]?.kind === "identifier" && tokens[alias + 1]?.value === "=") exportedNames.push(tokens[alias]!.value);
      continue;
    }
    if (["class", "const", "enum", "function", "interface", "let", "type", "var"].includes(form ?? "")) {
      let idCursor = cursor + 1;
      if (form === "function" && tokens[idCursor]?.value === "*") idCursor += 1;
      const identifier = tokens[idCursor];
      if (identifier?.kind === "identifier") exportedNames.push(identifier.value);
      continue;
    }
    if (form === "*") {
      // `export * as namespace from "..."` — a named namespace re-export.
      if (tokens[cursor + 1]?.value === "as" && tokens[cursor + 2]?.kind === "identifier") {
        exportedNames.push(tokens[cursor + 2]!.value);
      }
      // `export * from "..."` — bare re-export, no local name added.
      continue;
    }
    if (form !== "{") continue;
    cursor += 1;
    while (cursor < tokens.length && tokens[cursor]?.value !== "}") {
      if (tokens[cursor]?.value === "," || (tokens[cursor]?.value === "type" &&
        tokens[cursor + 1]?.kind === "identifier" && tokens[cursor + 1]?.value !== "as")) {
        cursor += 1;
        continue;
      }
      const local = tokens[cursor];
      if (local?.kind !== "identifier") {
        cursor += 1;
        continue;
      }
      if (tokens[cursor + 1]?.value === "as" && tokens[cursor + 2]?.kind === "identifier") {
        exportedNames.push(tokens[cursor + 2]!.value);
        cursor += 3;
      } else {
        exportedNames.push(local.value);
        cursor += 1;
      }
    }
  }
  const result = deepFreeze({ analysis, exportedNames: [...new Set(exportedNames)].toSorted() });
  if (cacheKey !== undefined) {
    if (staticModuleShapeCache.size >= STATIC_MODULE_SHAPE_CACHE_MAX_ENTRIES) {
      const oldest = staticModuleShapeCache.keys().next();
      if (!oldest.done) staticModuleShapeCache.delete(oldest.value);
    }
    staticModuleShapeCache.set(cacheKey, result);
    staticModuleShapeFilesystemCache.write(cacheKey, result);
  }
  return result;
}

// The ECMAScript punctuator production's multi-character members, longest
// first, so the scanner takes the maximal operator run the language itself
// takes. The optional-chaining punctuator carries the grammar's own lookahead
// restriction: `?.` is one token only when no decimal digit follows, so a
// ternary with a `.5` branch keeps three tokens.
const MULTI_CHARACTER_PUNCTUATION = [
  ">>>=",
  "...", "===", "!==", "**=", "<<=", ">>=", "&&=", "||=", "??=", ">>>",
  "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "++", "--", "**",
  "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<", ">>", "?.",
] as const;

// The previous-token values after which a `/` opens a regular expression
// literal rather than division. The single-character members are the latch
// set; a merged multi-character operator latches exactly when its final
// character already did, derived from the operator table so the two can
// never drift apart. The arrow is its own entry: an arrow's body begins an
// expression position, so a regex can follow it even though its final
// character never latched — the entry predates the merge and was dead
// while punctuation arrived one character at a time.
const REGULAR_EXPRESSION_LATCH_CHARACTERS = new Set(["(", ",", ":", "=", "[", "!", "&", "|", "?", "{", ";"]);
const REGULAR_EXPRESSION_LATCH_VALUES = new Set<string>([
  ...REGULAR_EXPRESSION_LATCH_CHARACTERS,
  "return",
  "=>",
  ...MULTI_CHARACTER_PUNCTUATION.filter((operator) =>
    REGULAR_EXPRESSION_LATCH_CHARACTERS.has(operator.at(-1) ?? "")),
]);

function precedesRegularExpressionLiteral(previous: Token | undefined): boolean {
  return REGULAR_EXPRESSION_LATCH_VALUES.has(previous?.value ?? "(");
}

function isTsxGenericArrow(source: string, start: number): boolean {
  // Use ordinary tokens for this lookahead: regexes, strings and comments
  // cannot impersonate delimiters. The plain-token mode never recurses here.
  const tokens = tokenizeSource(source.slice(start), false);
  const pairs = tokenDelimiterPairs(tokens);
  const parameter = tokens[1]?.value === "const" ? 2 : 1;
  if (tokens[parameter]?.kind !== "identifier" ||
    !([",", "="].includes(tokens[parameter + 1]?.value ?? "") ||
      (tokens[parameter + 1]?.kind === "identifier" && tokens[parameter + 1]?.value === "extends" && tokens[parameter + 2]?.value !== "="))) return false;
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind !== "punctuation") continue;
    const paired = pairs.get(index);
    if (paired !== undefined) { index = paired; continue; }
    if (token.value === "<") depth += 1;
    else if (/^>{1,3}$/u.test(token.value)) {
      depth -= token.value.length;
      if (depth < 0) return false;
      if (depth === 0) {
        const end = tokens[index + 1]?.value === "(" ? pairs.get(index + 1) : undefined;
        return end !== undefined && ["=>", ":"].includes(tokens[end + 1]?.value ?? "");
      }
    }
  }
  return false;
}

function sourceUsesJsx(sourcePath: string): boolean {
  const extension = ARCHITECTURE_SOURCE_EXTENSIONS.find((candidate) => sourcePath.endsWith(candidate));
  if (extension === undefined) throw new Error(`unsupported JavaScript source extension: ${sourcePath}`);
  return extension === ".jsx" || extension === ".tsx";
}

export function tokenizeStaticSource(source: string, sourcePath: string): readonly Token[] {
  if (typeof source !== "string" || typeof sourcePath !== "string") throw new Error("source and source path must be strings");
  return tokenizeSource(source, sourceUsesJsx(sourcePath));
}

function tokenizeSource(source: string, jsx: boolean): readonly Token[] {
  const tokens: Token[] = [];
  let mode: "javascript" | "tag" | "text" = "javascript";
  let jsxDepth = 0;
  let closingTag = false;
  const jsxReturns: number[] = [];
  const expressions: { mode: "tag" | "text"; braces: number }[] = [];
  for (let index = 0; index < source.length;) {
    const tokenStart = index;
    const character = source[index]!;
    const next = source[index + 1];
    if (mode !== "javascript") {
      if (character === "{") {
        expressions.push({ mode, braces: 1 });
        mode = "javascript";
        tokens.push({ start: tokenStart, kind: "punctuation", value: "{" });
        index += 1;
        continue;
      }
      if (mode === "text") {
        if (character === "<") { mode = "tag"; closingTag = next === "/"; if (!closingTag) jsxDepth += 1; }
        index += 1;
        continue;
      }
      if (character === '"' || character === "'") {
        const quote = character;
        while (++index < source.length && source[index] !== quote) { /* JSX attribute text is inert. */ }
        index += 1;
        continue;
      }
      if (character === ">") {
        if (closingTag || source[index - 1] === "/") jsxDepth -= 1;
        if (jsxReturns.at(-1) === jsxDepth) { jsxReturns.pop(); mode = "javascript"; }
        else mode = "text";
      }
      index += 1;
      continue;
    }
    const expression = expressions.at(-1);
    if (expression && character === "{") expression.braces += 1;
    if (expression && character === "}") {
      expression.braces -= 1;
      if (expression.braces === 0) { mode = expression.mode; expressions.pop(); }
    }
    if (jsx && character === "<" && (next === ">" || /[A-Za-z_$]/u.test(next ?? "")) &&
      (tokens.length === 0 || ["=", "(", "[", "{", ",", ":", "?", "return", "=>", "&&", "||", "??"].includes(tokens.at(-1)!.value))) {
      const genericArrow = isTsxGenericArrow(source, index);
      if (!genericArrow) {
        jsxReturns.push(jsxDepth);
        jsxDepth += 1;
        closingTag = false;
        mode = "tag";
        index += 1;
        continue;
      }
    }
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === "/" && next === "/") {
      index = source.indexOf("\n", index + 2);
      if (index === -1) break;
      continue;
    }
    if (character === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (character === "/" && next !== undefined && next !== "/" && next !== "*" &&
      precedesRegularExpressionLiteral(tokens.at(-1))) {
      index += 1;
      let inCharacterClass = false;
      while (index < source.length) {
        const current = source[index]!;
        if (current === "\\") {
          index += 2;
          continue;
        }
        if (current === "[") inCharacterClass = true;
        else if (current === "]") inCharacterClass = false;
        else if (current === "/" && !inCharacterClass) {
          index += 1;
          while (index < source.length && /[a-z]/iu.test(source[index]!)) index += 1;
          break;
        }
        index += 1;
      }
      tokens.push({ start: tokenStart, kind: "punctuation", value: "/regex/" });
      continue;
    }
    if (character === '"' || character === "'") {
      const quote = character;
      let value = "";
      index += 1;
      while (index < source.length) {
        const current = source[index]!;
        if (current === "\\") {
          const escaped = source[index + 1];
          if (escaped !== undefined) value += escaped;
          index += 2;
        } else if (current === quote) {
          index += 1;
          break;
        } else {
          value += current;
          index += 1;
        }
      }
      tokens.push({ start: tokenStart, kind: "string", value });
      continue;
    }
    if (character === "`") {
      let value = "";
      index += 1;
      while (index < source.length) {
        const current = source[index]!;
        if (current === "\\") {
          value += source.slice(index, index + 2);
          index += 2;
        } else if (current === "`") {
          index += 1;
          break;
        } else {
          value += current;
          index += 1;
        }
      }
      tokens.push({ start: tokenStart, kind: "template", value });
      continue;
    }
    if (/[A-Za-z_$]/u.test(character)) {
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_$]/u.test(source[index]!)) index += 1;
      tokens.push({ start: tokenStart, kind: "identifier", value: source.slice(start, index) });
      continue;
    }
    const operator = MULTI_CHARACTER_PUNCTUATION.find((candidate) =>
      source.startsWith(candidate, index) &&
      (candidate !== "?." || !/[0-9]/u.test(source[index + 2] ?? "")));
    if (operator !== undefined) {
      tokens.push({ start: tokenStart, kind: "punctuation", value: operator });
      index += operator.length;
      continue;
    }
    tokens.push({ start: tokenStart, kind: "punctuation", value: character });
    index += 1;
  }
  return deepFreeze(tokens);
}

function analyzeEnvironmentAcquisitions(tokens: readonly Token[]): Readonly<{
  environmentAcquisitions: readonly EnvironmentAcquisition[];
  unmodeledEnvironmentAccess: boolean;
}> {
  const environmentAcquisitions: EnvironmentAcquisition[] = [];
  let unmodeledEnvironmentAccess = false;
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.kind !== "identifier" || tokens[index]?.value !== "process") continue;
    const accessor = tokens[index + 1];
    if (accessor?.value === "." && tokens[index + 2]?.value === "env") {
      const afterEnvironment = tokens[index + 3];
      if (afterEnvironment?.value === "." && tokens[index + 4]?.kind === "identifier") {
        environmentAcquisitions.push({ form: "process.env.NAME", name: tokens[index + 4]!.value });
      } else if (afterEnvironment?.value === "[" && tokens[index + 4]?.kind === "string" &&
        tokens[index + 5]?.value === "]") {
        environmentAcquisitions.push({ form: "process.env['NAME']", name: tokens[index + 4]!.value });
      } else {
        unmodeledEnvironmentAccess = true;
      }
      continue;
    }
    if (accessor?.value === "[" && tokens[index + 2]?.kind === "string" &&
      tokens[index + 2]?.value === "env" && tokens[index + 3]?.value === "]") {
      const next = tokens[index + 4];
      let name: string | null = null;
      if (next?.value === "." && tokens[index + 5]?.kind === "identifier") name = tokens[index + 5]!.value;
      else if (next?.value === "[" && tokens[index + 5]?.kind === "string" && tokens[index + 6]?.value === "]") {
        name = tokens[index + 5]!.value;
      }
      environmentAcquisitions.push({ form: "process['env']", name });
      if (tokens[index - 1]?.value === "=") unmodeledEnvironmentAccess = true;
      continue;
    }
    if (accessor?.value !== ".") unmodeledEnvironmentAccess = true;
  }
  return { environmentAcquisitions, unmodeledEnvironmentAccess };
}
