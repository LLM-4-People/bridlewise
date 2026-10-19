/**
 * EXP447 — L7 SEMANTIC hallucination layer (ported + improved from EXP388).
 *
 * The structural grounding layer (L3) only checks that a name EXISTS. It
 * cannot catch an LLM that calls a REAL function but claims it returns a
 * boolean when it returns void, or claims it's async when it's sync, or
 * claims it lives on line 100 when it lives on line 14. EXP354 found this
 * was a 67% miss rate. EXP388 closed it to 0% by enriching the codebase
 * index with per-function semantic metadata (return type, parameter
 * names, async-ness, line number, thrown exceptions, class membership)
 * extracted via @babel/parser, then verifying the LLM's CLAIMS against
 * that enriched index.
 *
 * This module is the single owner of the semantic index shape + the
 * semantic verification logic. It is DETERMINISTIC and makes NO LLM
 * calls. Two entry points:
 *
 * - `buildSemanticIndexFromSources(sources)` — build the enriched index
 * from a list of {path, content} source files using @babel/parser.
 * - `verifySemanticClaims(claims, index, config)` — verify a list of
 * LLM claims against the index; returns a list of mismatches.
 *
 * Claim inference (when `semanticInferClaims` is on):
 * - `await X(...)` → claim X is async.
 * - `if (X(...))` → claim X returns a boolean/truthy.
 * - `try { X(...) } catch(T)` → claim X throws T.
 * - `X(...).sort((a,b)=>a.k-b.k)` → claim X's result is sorted by k.
 *
 * Type normalization: both sides are normalized via `normalizeType` so
 * "Promise<string>" matches "Promise<string>", "void" matches "void" /
 * "asserts...", namespace qualifiers are stripped (t.Node → Node). The
 * verifier does NOT resolve type aliases — it compares canonical textual
 * forms (with a configurable Jaccard threshold for loose matching).
 *
 * Per binding directive: no static constants — every threshold comes
 * from `HallucinationConfig`.
 */
import { parse, type ParserOptions } from "@babel/parser";
import { babelParserPluginsForSourcePath, type AstNode } from "../quality-packs/prevention/ast-helpers.ts";
import type { HallucinationConfig, SemanticClaimField } from "./hallucination-config.ts";
import { handleError } from "../shared/debug/debug-system.ts";

/** A single function's semantic metadata in the enriched index. */
export type SemanticFunctionRecord = Readonly<{
  name: string;
  file: string;
  /** 1-based line number where the function is declared. */
  line: number;
  /** TS return type annotation text (null if absent). */
  returnType: string | null;
  /** Parameter names in declaration order. */
  paramNames: readonly string[];
  /** Parameter TS type-annotation texts (null where absent). */
  paramTypes: readonly (string | null)[];
  /** Whether the function is async. */
  isAsync: boolean;
  /** Whether the function is a generator. */
  isGenerator: boolean;
  /** Exception types thrown in the body (e.g. ["TypeError"]). */
  throws: readonly string[];
  /** Class name for class methods; null for top-level functions. */
  className: string | null;
  /** Whether this is a default export. */
  isDefault: boolean;
  /** Argument count (paramNames.length, after stripping `this`). */
  argCount: number;
  /** Keys the return value is sorted by (from `.sort((a,b)=>a.k-b.k)`). */
  sortedBy: readonly string[];
}>;

/** The enriched semantic index: keyed by function name → records.
 * EXP461 (S3): also carries the AST-extracted structural sets (types,
 * imports, exports, paths) so the L3 grounding layer can use a single
 * AST source of truth instead of regex. */
export type SemanticIndex = Readonly<{
  byName: ReadonlyMap<string, readonly SemanticFunctionRecord[]>;
  /** All records in insertion order (for iteration / serialization). */
  records: readonly SemanticFunctionRecord[];
  /** EXP461 (S3): AST-extracted type/interface/class declaration names. */
  types: ReadonlySet<string>;
  /** EXP461 (S3): AST-extracted import source specifiers. */
  imports: ReadonlySet<string>;
  /** EXP461 (S3): AST-extracted exported names (named + default). */
  exports: ReadonlySet<string>;
  /** EXP461 (S3): source file paths (forward slashes, as given). */
  paths: ReadonlySet<string>;
}>;

/** A semantic claim extracted from the LLM response. */
export type SemanticClaim = Readonly<{
  /** The function name the claim is about. */
  ref: string;
  /** The field being claimed. */
  field: SemanticClaimField;
  /** The claimed value (type string, line number, param list, etc.). */
  value: string | number | boolean | readonly string[];
  /** Whether the claim was inferred from code (vs declared by the LLM). */
  inferred: boolean;
}>;

/** A semantic mismatch (a hallucination finding). */
export type SemanticMismatch = Readonly<{
  ref: string;
  field: SemanticClaimField;
  /** The LLM's claimed value. */
  claimed: string | number | boolean | readonly string[];
  /** The index's actual value. */
  actual: string | number | boolean | readonly string[] | null;
  /** Human-readable message. */
  message: string;
}>;

const SKIP_DIRS = new Set([
  "node_modules", "lib", "dist", "build", "test", "tests", "fixtures",
  ".git", ".cache", "generated", "vendor",
]);

function isSourcePath(p: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(p) && !SKIP_DIRS.has(p.split("/")[0] ?? "");
}

/** Strip namespace qualifiers + whitespace from a type string. */
export function normalizeType(t: string | null | undefined): string {
  if (t === null || t === undefined) return "";
  let s = String(t).trim();
  // Strip `t.X` / `this.X` / `module.X` namespace qualifiers → `X`.
  s = s.replace(/(?:^|[<(\[,\s|&+])(?:[a-zA-Z_$][\w$]*\.)+([A-Z][\w$]*)/g, (_m, p1) => p1);
  // Collapse "asserts x is T" / "asserts x" → "void" (an assertion returns void).
  if (/^asserts\b/.test(s)) return "void";
  // Strip surrounding parens.
  s = s.replace(/^\((.*)\)$/, "$1").trim();
  return s;
}

/** Tokenize a type string into a set of identifier tokens (for Jaccard). */
function typeTokens(t: string): Set<string> {
  const norm = normalizeType(t);
  if (norm.length === 0) return new Set();
  return new Set(norm.split(/[^A-Za-z0-9_$]+/).filter((s) => s.length > 0));
}

/** Jaccard similarity between two type strings. */
export function typeSimilarity(a: string | null, b: string | null): number {
  const ta = typeTokens(a ?? "");
  const tb = typeTokens(b ?? "");
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

function isAstNode(v: unknown): v is AstNode {
  return typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";
}

function asNode(v: unknown): AstNode | undefined {
  return isAstNode(v) ? (v as AstNode) : undefined;
}

function nodeLine(node: AstNode): number {
  const loc = (node as { loc?: { start?: { line?: number } } }).loc;
  return loc?.start?.line ?? 0;
}

/** Extract the return-type annotation text from a function node. */
function extractReturnType(node: AstNode): string | null {
  const rt = (node as { returnType?: unknown }).returnType;
  const r = asNode(rt);
  if (r === undefined) return null;
  // TSTypeAnnotation: { type: "TSTypeAnnotation", typeAnnotation: <node> }
  const inner = asNode((r as { typeAnnotation?: unknown }).typeAnnotation);
  if (inner === undefined) return null;
  return typeAnnotationText(inner);
}

function typeAnnotationText(node: AstNode): string {
  const t = (node as { type?: string }).type;
  switch (t) {
    // EXP461 (S2): unwrap the TSTypeAnnotation wrapper (`: T` → `T`). The
    // recursive renderer encounters this wrapper when rendering function-type
    // params + object-type members; unwrap to the inner type node.
    case "TSTypeAnnotation": {
      const inner = asNode((node as { typeAnnotation?: unknown }).typeAnnotation);
      return typeAnnotationText(inner ?? ({} as AstNode));
    }
    case "TSStringKeyword": return "string";
    case "TSNumberKeyword": return "number";
    case "TSBooleanKeyword": return "boolean";
    case "TSVoidKeyword": return "void";
    case "TSAnyKeyword": return "any";
    case "TSUnknownKeyword": return "unknown";
    case "TSNullKeyword": return "null";
    case "TSUndefinedKeyword": return "undefined";
    case "TSNeverKeyword": return "never";
    case "TSSymbolKeyword": return "symbol";
    case "TSObjectKeyword": return "object";
    case "TSBigIntKeyword": return "bigint";
    case "TSThisType": return "this";
    case "TSTypePredicate": {
      // `asserts x is T` → "void" (an assertion returns void at runtime).
      // `x is T` (non-asserts) → "boolean" (a type guard returns boolean).
      const asserts = Boolean((node as { asserts?: unknown }).asserts);
      if (asserts) return "void";
      return "boolean";
    }
    case "TSImportType": {
      // `import("mod").X` → "X" (strip the import source, keep the qualifier).
      const qual = asNode((node as { qualifier?: unknown }).qualifier);
      if (qual !== undefined) {
        const q = identifierName(qual);
        if (q.length > 0) return q;
      }
      return "ImportedType";
    }
    case "TSArrayType": {
      const elt = asNode((node as { elementType?: unknown }).elementType);
      return `${typeAnnotationText(elt ?? ({} as AstNode))}[]`;
    }
    case "TSUnionType": {
      const types = (node as { types?: unknown[] }).types ?? [];
      return types.map((x) => typeAnnotationText(asNode(x) ?? ({} as AstNode))).join(" | ");
    }
    case "TSIntersectionType": {
      const types = (node as { types?: unknown[] }).types ?? [];
      return types.map((x) => typeAnnotationText(asNode(x) ?? ({} as AstNode))).join(" & ");
    }
    case "TSParenthesizedType": {
      const inner = asNode((node as { typeAnnotation?: unknown }).typeAnnotation);
      return typeAnnotationText(inner ?? ({} as AstNode));
    }
    case "TSTypeReference": {
      const nameNode = asNode((node as { typeName?: unknown }).typeName);
      const name = nameNode !== undefined ? identifierName(nameNode) : "";
      // Babel uses `typeArguments` (TSTypeParameterInstantiation) for TSTypeReference.
      const typeArgs = (node as { typeArguments?: unknown }).typeArguments;
      const tp = asNode(typeArgs);
      if (tp !== undefined) {
        const params = (tp as { params?: unknown[] }).params ?? [];
        if (params.length > 0) {
          const inner = params.map((x) => typeAnnotationText(asNode(x) ?? ({} as AstNode))).join(", ");
          return `${name}<${inner}>`;
        }
      }
      return name;
    }
    case "TSTypeLiteral": {
      // EXP461 (S2): render the actual member signatures instead of a bare
      // count `{N}` (coarse). Each member is `name: type` (for property
      // signatures) or `type` (for call/index signatures). Bounded to
      // `config`-free recursion via the shared renderer.
      const members = (node as { members?: unknown[] }).members ?? [];
      const parts = members.map((m) => typeMemberText(asNode(m) ?? ({} as AstNode)));
      return `{ ${parts.join("; ")} }`;
    }
    case "TSFunctionType": {
      // EXP461 (S2): render `(params) => returnType` instead of "Function".
      const params = (node as { params?: unknown[] }).params ?? [];
      const paramStr = params
        .map((p) => typeAnnotationParamText(asNode(p) ?? ({} as AstNode)))
        .join(", ");
      const ret = asNode((node as { typeAnnotation?: unknown }).typeAnnotation);
      const rt = ret !== undefined ? typeAnnotationText(ret) : "void";
      return `(${paramStr}) => ${rt}`;
    }
    case "TSTupleType": {
      // EXP461 (S2): render the element types instead of "tuple".
      const elements = (node as { elementTypes?: unknown[] }).elementTypes ?? [];
      return `[${elements.map((e) => typeAnnotationText(asNode(e) ?? ({} as AstNode))).join(", ")}]`;
    }
    case "TSTemplateLiteralType": {
      // EXP461 (S2): render `head ${middle} tail` instead of "string".
      const quasi = (node as { quasis?: unknown[] }).quasis ?? [];
      const types = (node as { types?: unknown[] }).types ?? [];
      let out = "";
      for (let i = 0; i < quasi.length; i += 1) {
        const q = asNode(quasi[i]);
        out += q !== undefined ? templateQuasiValue(q) : "";
        const ty = asNode(types[i]);
        if (ty !== undefined) out += `\${${typeAnnotationText(ty)}}`;
      }
      return out.length > 0 ? out : "string";
    }
    case "TSConditionalType": {
      // EXP461 (S2): render `check? true: false` instead of "conditional".
      const check = asNode((node as { checkType?: unknown }).checkType);
      const tru = asNode((node as { trueType?: unknown }).trueType);
      const fal = asNode((node as { falseType?: unknown }).falseType);
      return `${check !== undefined ? typeAnnotationText(check) : "?"} ? ${tru !== undefined ? typeAnnotationText(tru) : "?"} : ${fal !== undefined ? typeAnnotationText(fal) : "?"}`;
    }
    case "TSMappedType": {
      // EXP461 (S2): render `{ [name in constraint]: type }` instead of "mapped".
      const tp = asNode((node as { typeParameter?: unknown }).typeParameter);
      let constraint = "";
      let name = "";
      if (tp !== undefined) {
        const cn = asNode((tp as { constraint?: unknown }).constraint);
        constraint = cn !== undefined ? typeAnnotationText(cn) : "unknown";
        name = identifierName(asNode((tp as { name?: unknown }).name) ?? ({} as AstNode));
      }
      const ann = asNode((node as { typeAnnotation?: unknown }).typeAnnotation);
      const rt = ann !== undefined ? typeAnnotationText(ann) : "unknown";
      return `{ [${name} in ${constraint}]: ${rt} }`;
    }
    case "TSIndexedAccessType": {
      // EXP461 (S2): render `obj[index]` instead of "indexed".
      const obj = asNode((node as { objectType?: unknown }).objectType);
      const idx = asNode((node as { indexType?: unknown }).indexType);
      return `${obj !== undefined ? typeAnnotationText(obj) : "?"}[${idx !== undefined ? typeAnnotationText(idx) : "?"}]`;
    }
    case "TSInferType": {
      // EXP461 (S2): render `infer name` instead of "infer".
      const tp = asNode((node as { typeParameter?: unknown }).typeParameter);
      const name = tp !== undefined ? identifierName(asNode((tp as { name?: unknown }).name) ?? ({} as AstNode)) : "";
      return `infer ${name}`;
    }
    case "TSLiteralType": {
      const expr = asNode((node as { literal?: unknown }).literal);
      if (expr === undefined) return "literal";
      const et = (expr as { type?: string }).type;
      if (et === "StringLiteral") return "string";
      if (et === "NumericLiteral") return "number";
      if (et === "BooleanLiteral") return "boolean";
      if (et === "NullLiteral") return "null";
      return "literal";
    }
    default: return t ?? "unknown";
  }
}

/** EXP461 (S2): render a single object-type member (property/call/index signature). */
function typeMemberText(node: AstNode): string {
  const t = (node as { type?: string }).type;
  if (t === "TSPropertySignature" || t === "TSMethodSignature") {
    const key = asNode((node as { key?: unknown }).key);
    const name = key !== undefined ? identifierName(key) : "";
    const ann = asNode((node as { typeAnnotation?: unknown }).typeAnnotation);
    const rt = ann !== undefined ? typeAnnotationText(ann) : "any";
    const opt = Boolean((node as { optional?: unknown }).optional) ? "?" : "";
    return `${name}${opt}: ${rt}`;
  }
  if (t === "TSCallSignatureDeclaration") {
    const params = (node as { params?: unknown[] }).params ?? [];
    const paramStr = params.map((p) => typeAnnotationParamText(asNode(p) ?? ({} as AstNode))).join(", ");
    const ret = asNode((node as { typeAnnotation?: unknown }).typeAnnotation);
    const rt = ret !== undefined ? typeAnnotationText(ret) : "void";
    return `(${paramStr}): ${rt}`;
  }
  if (t === "TSIndexSignature") {
    const params = (node as { parameters?: unknown[] }).parameters ?? [];
    const paramStr = params.map((p) => typeAnnotationParamText(asNode(p) ?? ({} as AstNode))).join(", ");
    const ret = asNode((node as { typeAnnotation?: unknown }).typeAnnotation);
    const rt = ret !== undefined ? typeAnnotationText(ret) : "void";
    return `[${paramStr}]: ${rt}`;
  }
  return typeAnnotationText(node);
}

/** EXP461 (S2): render a single function-type parameter (for TSFunctionType). */
function typeAnnotationParamText(node: AstNode): string {
  const t = (node as { type?: string }).type;
  if (t === "Identifier") {
    const name = String((node as { name?: string }).name ?? "");
    const ann = asNode((node as { typeAnnotation?: unknown }).typeAnnotation);
    return ann !== undefined ? `${name}: ${typeAnnotationText(ann)}` : name;
  }
  return typeAnnotationText(node);
}

/** EXP461 (S2): render a template-literal quasi's cooked/raw value. */
function templateQuasiValue(node: AstNode): string {
  const raw = (node as { value?: { raw?: string; cooked?: string } }).value;
  if (raw === undefined) return "";
  return raw.cooked ?? raw.raw ?? "";
}

function identifierName(node: AstNode): string {
  const t = (node as { type?: string }).type;
  if (t === "Identifier") return String((node as { name?: string }).name ?? "");
  if (t === "TSQualifiedName") {
    const left = asNode((node as { left?: unknown }).left);
    const right = asNode((node as { right?: unknown }).right);
    const l = left !== undefined ? identifierName(left) : "";
    const r = right !== undefined ? identifierName(right) : "";
    return r.length > 0 ? r : l;
  }
  return "";
}

/** Extract parameter names + types from a function node's params. */
function extractParams(
  node: AstNode,
): { names: string[]; types: (string | null)[] } {
  const params = (node as { params?: unknown[] }).params ?? [];
  const names: string[] = [];
  const types: (string | null)[] = [];
  for (const p of params) {
    const pn = asNode(p);
    if (pn === undefined) continue;
    // TSParameterProperty: { parameter: Identifier }
    const t = (pn as { type?: string }).type;
    if (t === "Identifier") {
      names.push(String((pn as { name?: string }).name ?? ""));
      const ann = asNode((pn as { typeAnnotation?: unknown }).typeAnnotation);
      types.push(ann !== undefined ? typeAnnotationText(ann) : null);
    } else if (t === "AssignmentPattern") {
      const left = asNode((pn as { left?: unknown }).left);
      if (left !== undefined && (left as { type?: string }).type === "Identifier") {
        names.push(String((left as { name?: string }).name ?? ""));
      } else {
        names.push("_");
      }
      types.push(null);
    } else if (t === "RestElement") {
      const arg = asNode((pn as { argument?: unknown }).argument);
      if (arg !== undefined && (arg as { type?: string }).type === "Identifier") {
        names.push("..." + String((arg as { name?: string }).name ?? ""));
      } else {
        names.push("...args");
      }
      types.push(null);
    } else if (t === "ObjectPattern") {
      // Destructuring parameter — name it by shape.
      names.push("{...}");
      types.push(null);
    } else if (t === "ArrayPattern") {
      names.push("[...]");
      types.push(null);
    } else if (t === "TSParameterProperty") {
      const inner = asNode((pn as { parameter?: unknown }).parameter);
      if (inner !== undefined && (inner as { type?: string }).type === "Identifier") {
        names.push(String((inner as { name?: string }).name ?? ""));
        const ann = asNode((inner as { typeAnnotation?: unknown }).typeAnnotation);
        types.push(ann !== undefined ? typeAnnotationText(ann) : null);
      } else {
        names.push("_");
        types.push(null);
      }
    } else {
      names.push("_");
      types.push(null);
    }
  }
  return { names, types };
}

/** Extract thrown exception types from a function body (walks ThrowStatement). */
function extractThrows(body: AstNode): string[] {
  const throws: string[] = [];
  const seen = new Set<string>();
  const stack: unknown[] = [body];
  while (stack.length > 0) {
    const n = stack.pop();
    const node = asNode(n);
    if (node === undefined) continue;
    const t = (node as { type?: string }).type;
    if (t === "ThrowStatement") {
      const arg = asNode((node as { argument?: unknown }).argument);
      if (arg !== undefined) {
        const at = (arg as { type?: string }).type;
        if (at === "NewExpression") {
          const callee = asNode((arg as { callee?: unknown }).callee);
          if (callee !== undefined && (callee as { type?: string }).type === "Identifier") {
            const name = String((callee as { name?: string }).name ?? "");
            if (name.length > 0 && !seen.has(name)) { seen.add(name); throws.push(name); }
          }
        } else if (at === "Identifier") {
          const name = String((arg as { name?: string }).name ?? "");
          if (name.length > 0 && !seen.has(name)) { seen.add(name); throws.push(name); }
        }
      }
    }
    // Don't descend into nested function declarations/expressions (their throws are their own).
    if (t !== "FunctionDeclaration" && t !== "FunctionExpression" && t !== "ArrowFunctionExpression" && t !== "ClassMethod" && t !== "ObjectMethod") {
      for (const k of Object.keys(node)) {
        if (k === "loc" || k === "start" || k === "end" || k === "range" || k === "type") continue;
        const v = (node as Record<string, unknown>)[k];
        if (Array.isArray(v)) for (const c of v) stack.push(c);
        else if (isAstNode(v)) stack.push(v);
      }
    }
  }
  return throws;
}

/** Extract sort keys from `.sort((a,b)=>a.k-b.k)` patterns in the body. */
function extractSortedBy(body: AstNode): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const stack: unknown[] = [body];
  while (stack.length > 0) {
    const n = stack.pop();
    const node = asNode(n);
    if (node === undefined) continue;
    const t = (node as { type?: string }).type;
    if (t === "CallExpression") {
      const callee = asNode((node as { callee?: unknown }).callee);
      if (callee !== undefined && (callee as { type?: string }).type === "MemberExpression" && (callee as { property?: unknown }).property !== undefined) {
        const prop = asNode((callee as { property?: unknown }).property);
        if (prop !== undefined && (prop as { type?: string }).type === "Identifier" && (prop as { name?: string }).name === "sort") {
          const args = (node as { arguments?: unknown[] }).arguments ?? [];
          const cmp = asNode(args[0]);
          if (cmp !== undefined && (cmp as { type?: string }).type === "ArrowFunctionExpression") {
            const cb = asNode((cmp as { body?: unknown }).body);
            if (cb !== undefined && (cb as { type?: string }).type === "BinaryExpression") {
              const left = asNode((cb as { left?: unknown }).left);
              const right = asNode((cb as { right?: unknown }).right);
              if (left !== undefined && (left as { type?: string }).type === "MemberExpression") {
                const lp = asNode((left as { property?: unknown }).property);
                if (lp !== undefined && (lp as { type?: string }).type === "Identifier") {
                  const k = String((lp as { name?: string }).name ?? "");
                  if (k.length > 0 && !seen.has(k)) { seen.add(k); keys.push(k); }
                }
              }
              if (right !== undefined && (right as { type?: string }).type === "MemberExpression") {
                const rp = asNode((right as { property?: unknown }).property);
                if (rp !== undefined && (rp as { type?: string }).type === "Identifier") {
                  const k = String((rp as { name?: string }).name ?? "");
                  if (k.length > 0 && !seen.has(k)) { seen.add(k); keys.push(k); }
                }
              }
            }
          }
        }
      }
    }
    for (const k of Object.keys(node)) {
      if (k === "loc" || k === "start" || k === "end" || k === "range" || k === "type") continue;
      const v = (node as Record<string, unknown>)[k];
      if (Array.isArray(v)) for (const c of v) stack.push(c);
      else if (isAstNode(v)) stack.push(v);
    }
  }
  return keys;
}

function parserOptsForPath(p: string): ParserOptions {
  const plugins = [...babelParserPluginsForSourcePath(p)] as ParserOptions["plugins"];
  return {
    sourceType: "module",
    errorRecovery: true,
    plugins: plugins ?? [],
    ranges: false,
    tokens: false,
  };
}

function visitFunctions(
  node: AstNode,
  file: string,
  className: string | null,
  out: SemanticFunctionRecord[],
): void {
  const t = (node as { type?: string }).type;
  if (t === "FunctionDeclaration" || t === "FunctionExpression" || t === "ArrowFunctionExpression") {
    const id = asNode((node as { id?: unknown }).id);
    const name = id !== undefined ? String((id as { name?: string }).name ?? "") : (className ?? "<anonymous>");
    if (name.length > 0 && name !== "<anonymous>") {
      const { names, types } = extractParams(node);
      const body = asNode((node as { body?: unknown }).body) ?? ({} as AstNode);
      out.push({
        name,
        file,
        line: nodeLine(node),
        returnType: extractReturnType(node),
        paramNames: names,
        paramTypes: types,
        isAsync: Boolean((node as { async?: unknown }).async),
        isGenerator: Boolean((node as { generator?: unknown }).generator),
        throws: extractThrows(body),
        className,
        isDefault: false,
        argCount: names.filter((n) => n !== "this").length,
        sortedBy: extractSortedBy(body),
      });
    }
  }
  if (t === "ClassDeclaration" || t === "ClassExpression") {
    const cname = (() => {
      const id = asNode((node as { id?: unknown }).id);
      return id !== undefined ? String((id as { name?: string }).name ?? "") : "";
    })();
    const body = asNode((node as { body?: unknown }).body);
    if (body !== undefined) {
      const bodyNode = body as AstNode;
      const methods = (bodyNode as { body?: unknown[] }).body ?? [];
      for (const m of methods) {
        const mn = asNode(m);
        if (mn === undefined) continue;
        const mt = (mn as { type?: string }).type;
        if (mt === "ClassMethod" || mt === "ClassPrivateMethod") {
          const key = asNode((mn as { key?: unknown }).key);
          const mname = key !== undefined && (key as { type?: string }).type === "Identifier"
            ? String((key as { name?: string }).name ?? "")
            : "<computed>";
          if (mname.length > 0 && mname !== "<computed>") {
            const { names, types } = extractParams(mn);
            const mbody = asNode((mn as { body?: unknown }).body) ?? ({} as AstNode);
            out.push({
              name: mname,
              file,
              line: nodeLine(mn),
              returnType: extractReturnType(mn),
              paramNames: names,
              paramTypes: types,
              isAsync: Boolean((mn as { async?: unknown }).async),
              isGenerator: Boolean((mn as { generator?: unknown }).generator),
              throws: extractThrows(mbody),
              className: cname.length > 0 ? cname : null,
              isDefault: false,
              argCount: names.filter((n) => n !== "this").length,
              sortedBy: extractSortedBy(mbody),
            });
          }
        }
      }
    }
  }
  if (t === "ExportDefaultDeclaration") {
    const decl = asNode((node as { declaration?: unknown }).declaration);
    if (decl !== undefined) {
      const before = out.length;
      visitFunctions(decl, file, null, out);
      // Mark the just-added records as default-exported.
      for (let i = before; i < out.length; i++) {
        const r = out[i];
        if (r !== undefined) {
          out[i] = { ...r, isDefault: true };
        }
      }
    }
    return;
  }
  if (t === "ExportNamedDeclaration") {
    const decl = asNode((node as { declaration?: unknown }).declaration);
    if (decl !== undefined) visitFunctions(decl, file, null, out);
    return;
  }
  if (t === "ObjectExpression") {
    const props = (node as { properties?: unknown[] }).properties ?? [];
    for (const p of props) {
      const pn = asNode(p);
      if (pn === undefined) continue;
      if ((pn as { type?: string }).type === "ObjectMethod") {
        const key = asNode((pn as { key?: unknown }).key);
        const mname = key !== undefined && (key as { type?: string }).type === "Identifier"
          ? String((key as { name?: string }).name ?? "")
          : "<computed>";
        if (mname.length > 0 && mname !== "<computed>") {
          const { names, types } = extractParams(pn);
          const body = asNode((pn as { body?: unknown }).body) ?? ({} as AstNode);
          out.push({
            name: mname, file, line: nodeLine(pn),
            returnType: extractReturnType(pn),
            paramNames: names, paramTypes: types,
            isAsync: Boolean((pn as { async?: unknown }).async),
            isGenerator: Boolean((pn as { generator?: unknown }).generator),
            throws: extractThrows(body), className: null, isDefault: false,
            argCount: names.filter((n) => n !== "this").length,
            sortedBy: extractSortedBy(body),
          });
        }
      }
    }
    return;
  }
  if (t === "VariableDeclarator") {
    const init = asNode((node as { init?: unknown }).init);
    if (init !== undefined) {
      const it = (init as { type?: string }).type;
      if (it === "FunctionExpression" || it === "ArrowFunctionExpression") {
        const id = asNode((node as { id?: unknown }).id);
        if (id !== undefined && (id as { type?: string }).type === "Identifier") {
          const name = String((id as { name?: string }).name ?? "");
          if (name.length > 0) {
            const { names, types } = extractParams(init);
            const body = asNode((init as { body?: unknown }).body) ?? ({} as AstNode);
            out.push({
              name, file, line: nodeLine(init),
              returnType: extractReturnType(init),
              paramNames: names, paramTypes: types,
              isAsync: Boolean((init as { async?: unknown }).async),
              isGenerator: Boolean((init as { generator?: unknown }).generator),
              throws: extractThrows(body), className, isDefault: false,
              argCount: names.filter((n) => n !== "this").length,
              sortedBy: extractSortedBy(body),
            });
          }
        }
      }
    }
    return;
  }
  // Generic descent.
  for (const k of Object.keys(node)) {
    if (k === "loc" || k === "start" || k === "end" || k === "range" || k === "type") continue;
    const v = (node as Record<string, unknown>)[k];
    if (Array.isArray(v)) {
      for (const c of v) {
        const cn = asNode(c);
        if (cn !== undefined) visitFunctions(cn, file, className, out);
      }
    } else if (isAstNode(v)) {
      visitFunctions(v as AstNode, file, className, out);
    }
  }
}

/** EXP461 (S3): walk the top-level program for type/import/export/path
 * declarations (a single AST pass; the regex index is replaced by this). */
function collectStructuralDecls(
  program: AstNode,
  srcPath: string,
  out: { types: Set<string>; imports: Set<string>; exports: Set<string>; paths: Set<string> },
): void {
  out.paths.add(srcPath);
  const stack: unknown[] = [program];
  while (stack.length > 0) {
    const n = stack.pop();
    const node = asNode(n);
    if (node === undefined) continue;
    const t = (node as { type?: string }).type;
    // Type declarations: interface, type alias, class, enum.
    if (t === "TSInterfaceDeclaration" || t === "TSTypeAliasDeclaration" || t === "ClassDeclaration" || t === "ClassExpression" || t === "TSEnumDeclaration") {
      const id = asNode((node as { id?: unknown }).id);
      if (id !== undefined) out.types.add(String((id as { name?: string }).name ?? ""));
    }
    // Imports: import source specifier.
    if (t === "ImportDeclaration" || t === "TSImportEqualsDeclaration") {
      const src = (node as { source?: { value?: string } }).source?.value;
      if (typeof src === "string" && src.length > 0) out.imports.add(src);
    }
    if (t === "ExportNamedDeclaration") {
      const decl = asNode((node as { declaration?: unknown }).declaration);
      if (decl !== undefined) {
        const id = asNode((decl as { id?: unknown }).id);
        if (id !== undefined) out.exports.add(String((id as { name?: string }).name ?? ""));
      }
      // re-exports: export { a, b } from "src"
      const src = (node as { source?: { value?: string } }).source?.value;
      if (typeof src === "string") out.imports.add(src);
    }
    if (t === "ExportDefaultDeclaration") {
      out.exports.add("default");
    }
    // Don't descend into function bodies (only top-level declarations matter).
    if (t === "FunctionDeclaration" || t === "FunctionExpression" || t === "ArrowFunctionExpression" || t === "ClassMethod" || t === "ObjectMethod") continue;
    for (const k of Object.keys(node)) {
      if (k === "loc" || k === "start" || k === "end" || k === "range" || k === "type") continue;
      const v = (node as Record<string, unknown>)[k];
      if (Array.isArray(v)) for (const c of v) stack.push(c);
      else if (isAstNode(v)) stack.push(v);
    }
  }
}

/** Build an enriched semantic index from a list of source files. */
export function buildSemanticIndexFromSources(
  sources: ReadonlyArray<Readonly<{ path: string; content: string }>>,
): SemanticIndex {
  const records: SemanticFunctionRecord[] = [];
  const types = new Set<string>();
  const imports = new Set<string>();
  const exports = new Set<string>();
  const paths = new Set<string>();
  for (const src of sources) {
    if (!isSourcePath(src.path)) continue;
    let ast: unknown;
    try {
      ast = parse(src.content, parserOptsForPath(src.path));
    } catch (e) {handleError(e, { module: "safety-hallucination-semantic", operation: "catch" });
      continue; // unparseable file → skip (honest degradation, no silent injection)
    }
    const program = asNode(ast);
    if (program === undefined) continue;
    visitFunctions(program, src.path, null, records);
    // EXP461 (S3): collect structural declarations from the SAME AST pass.
    collectStructuralDecls(program, src.path, { types, imports, exports, paths });
  }
  const byName = new Map<string, SemanticFunctionRecord[]>();
  for (const r of records) {
    const list = byName.get(r.name);
    if (list === undefined) byName.set(r.name, [r]);
    else list.push(r);
  }
  return { byName, records, types, imports, exports, paths };
}

/** Look up function records by name (optionally filtered by class). */
export function lookupFunction(
  name: string,
  index: SemanticIndex,
  className: string | null = null,
): readonly SemanticFunctionRecord[] {
  const list = index.byName.get(name);
  if (list === undefined) return [];
  if (className !== null) {
    const filtered = list.filter((r) => r.className === className);
    return filtered.length > 0 ? filtered : list;
  }
  return list;
}

function claimEquals(
  field: SemanticClaimField,
  claimed: string | number | boolean | readonly string[],
  actual: string | number | boolean | readonly string[] | null,
  config: HallucinationConfig,
): boolean {
  switch (field) {
    case "returns": {
      if (actual === null) return false;
      const cn = normalizeType(String(claimed));
      const an = normalizeType(String(actual));
      if (cn === an) return true;
      return typeSimilarity(cn, an) >= config.semanticTypeSimilarityThreshold;
    }
    case "async": {
      if (typeof claimed !== "boolean" || typeof actual !== "boolean") return false;
      return claimed === actual;
    }
    case "line": {
      if (typeof claimed !== "number" || typeof actual !== "number") return false;
      return Math.abs(claimed - actual) <= config.semanticLineTolerance;
    }
    case "argCount": {
      if (typeof claimed !== "number" || typeof actual !== "number") return false;
      return claimed === actual;
    }
    case "isDefault": {
      if (typeof claimed !== "boolean" || typeof actual !== "boolean") return false;
      return claimed === actual;
    }
    case "params": {
      if (!Array.isArray(claimed) || actual === null || !Array.isArray(actual)) return false;
      const c = (claimed as readonly string[]).filter((p) => p !== "this");
      const a = (actual as readonly string[]).filter((p) => p !== "this");
      if (c.length !== a.length) return false;
      return c.every((p, i) => p === a[i]);
    }
    case "throws": {
      if (!Array.isArray(claimed) || actual === null || !Array.isArray(actual)) return false;
      if (claimed.length === 0) return actual.length === 0;
      const aSet = new Set(actual as readonly string[]);
      return (claimed as readonly string[]).every((t) => aSet.has(t));
    }
    case "className": {
      if (typeof claimed !== "string" || typeof actual !== "string") return claimed === actual;
      return claimed === actual;
    }
    default: return false;
  }
}

function actualValueFor(
  field: SemanticClaimField,
  record: SemanticFunctionRecord,
): string | number | boolean | readonly string[] | null {
  switch (field) {
    case "returns": return record.returnType ?? "void";
    case "async": return record.isAsync;
    case "line": return record.line;
    case "argCount": return record.argCount;
    case "isDefault": return record.isDefault;
    case "params": return record.paramNames;
    case "throws": return record.throws;
    case "className": return record.className;
    default: return null;
  }
}

/**
 * Verify a list of semantic claims against the index. Returns a list of
 * mismatches (one per claim that does NOT match ANY candidate record).
 */
export function verifySemanticClaims(
  claims: readonly SemanticClaim[],
  index: SemanticIndex,
  config: HallucinationConfig,
): readonly SemanticMismatch[] {
  const mismatches: SemanticMismatch[] = [];
  let processed = 0;
  for (const claim of claims) {
    if (processed >= config.maxSemanticClaimsPerResponse) break;
    processed++;
    const candidates = lookupFunction(claim.ref, index, null);
    if (candidates.length === 0) {
      // Name not in the semantic index — the grounding layer handles this.
      // Skip (not a semantic mismatch; it's a structural one).
      continue;
    }
    const actual = actualValueFor(claim.field, candidates[0]!);
    const anyMatch = candidates.some((rec) => claimEquals(claim.field, claim.value, actualValueFor(claim.field, rec), config));
    if (!anyMatch) {
      mismatches.push({
        ref: claim.ref,
        field: claim.field,
        claimed: claim.value,
        actual,
        message: `semantic mismatch for "${claim.ref}": claimed ${claim.field}=${formatVal(claim.value)}, actual=${formatVal(actual)}`,
      });
    }
  }
  return mismatches;
}

function formatVal(v: string | number | boolean | readonly string[] | null): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `[${v.join(", ")}]`;
  if (typeof v === "boolean") return String(v);
  return String(v);
}

/**
 * Infer semantic claims from LLM code body (when `semanticInferClaims` is on).
 * - `await X(...)` → claim X is async=true.
 * - `if (X(...))` → claim X returns boolean (truthy).
 * - `try { X(...) } catch(T)` → claim X throws T.
 *
 * EXP461 (S4): the walk is split into `inferClaimsFromAst(program, config)`
 * so the caller can reuse a pre-parsed AST (the response is parsed ONCE —
 * both reference extraction and claim inference consume the same tree,
 * halving the parse cost). `inferClaimsFromCode` keeps the string API.
 *
 * EXP447: an optional `preParsedAst` lets a caller that already parsed the
 * code skip the re-parse. When provided and valid, the `code` string is NOT
 * parsed again (the AST is used directly) — passing a deliberately different
 * AST proves no re-parse occurs.
 */
export function inferClaimsFromCode(
  code: string,
  config: HallucinationConfig,
  preParsedAst?: unknown,
): readonly SemanticClaim[] {
  if (!config.semanticInferClaims) return [];
  let ast: unknown;
  if (preParsedAst !== undefined) {
    // Use the caller-supplied AST verbatim — do NOT re-parse `code`.
    ast = preParsedAst;
  } else {
    try {
      ast = parse(code, { sourceType: "module", errorRecovery: true, plugins: ["typescript"] });
    } catch {
      return [];
    }
  }
  const program = asNode(ast);
  if (program === undefined) return [];
  return inferClaimsFromAst(program, config);
}

/** EXP461 (S4): infer claims from a pre-parsed AST program node. */
export function inferClaimsFromAst(
  program: AstNode,
  config: HallucinationConfig,
): readonly SemanticClaim[] {
  if (!config.semanticInferClaims) return [];
  const claims: SemanticClaim[] = [];
  const stack: unknown[] = [program];
  while (stack.length > 0) {
    const n = stack.pop();
    const node = asNode(n);
    if (node === undefined) continue;
    const t = (node as { type?: string }).type;
    if (t === "AwaitExpression") {
      const arg = asNode((node as { argument?: unknown }).argument);
      if (arg !== undefined && (arg as { type?: string }).type === "CallExpression") {
        const callee = asNode((arg as { callee?: unknown }).callee);
        if (callee !== undefined && (callee as { type?: string }).type === "Identifier") {
          const name = String((callee as { name?: string }).name ?? "");
          if (name.length > 0) claims.push({ ref: name, field: "async", value: true, inferred: true });
        }
      }
    }
    if (t === "IfStatement") {
      const test = asNode((node as { test?: unknown }).test);
      if (test !== undefined && (test as { type?: string }).type === "CallExpression") {
        const callee = asNode((test as { callee?: unknown }).callee);
        if (callee !== undefined && (callee as { type?: string }).type === "Identifier") {
          const name = String((callee as { name?: string }).name ?? "");
          if (name.length > 0) claims.push({ ref: name, field: "returns", value: "boolean", inferred: true });
        }
      }
    }
    if (t === "TryStatement") {
      const handler = asNode((node as { handler?: unknown }).handler);
      if (handler !== undefined) {
        const param = asNode((handler as { param?: unknown }).param);
        if (param !== undefined && (param as { type?: string }).type === "Identifier") {
          const ann = asNode((param as { typeAnnotation?: unknown }).typeAnnotation);
          if (ann !== undefined) {
            const inner = asNode((ann as { typeAnnotation?: unknown }).typeAnnotation);
            const exType = inner !== undefined ? typeAnnotationText(inner) : null;
            if (exType !== null) {
              claims.push({ ref: "<try-body>", field: "throws", value: [exType], inferred: true });
            }
          }
        }
      }
    }
    for (const k of Object.keys(node)) {
      if (k === "loc" || k === "start" || k === "end" || k === "range" || k === "type") continue;
      const v = (node as Record<string, unknown>)[k];
      if (Array.isArray(v)) for (const c of v) stack.push(c);
      else if (isAstNode(v)) stack.push(v);
    }
  }
  return claims;
}

/**
 * Signature-aware auto-correction (EXP388). When the LLM declares a WRONG
 * arg count or param names for a real function, correct them using the
 * semantic index. Returns a correction or null.
 */
export function autoCorrectSignature(
  ref: string,
  field: "argCount" | "params",
  claimed: number | readonly string[],
  index: SemanticIndex,
): Readonly<{ ref: string; field: "argCount" | "params"; from: string; to: string }> | null {
  const candidates = lookupFunction(ref, index, null);
  if (candidates.length === 0) return null;
  if (field === "argCount") {
    if (typeof claimed !== "number") return null;
    let best = candidates[0]!;
    let bestDiff = Infinity;
    for (const c of candidates) {
      if (c.argCount === claimed) return null; // already correct for some candidate
      const d = Math.abs(c.argCount - claimed);
      if (d < bestDiff) { bestDiff = d; best = c; }
    }
    return { ref, field: "argCount", from: String(claimed), to: String(best.argCount) };
  }
  if (field === "params") {
    if (!Array.isArray(claimed)) return null;
    const c = (claimed as readonly string[]).filter((p) => p !== "this");
    for (const cand of candidates) {
      const a = cand.paramNames.filter((p) => p !== "this");
      if (a.length === c.length && a.every((p, i) => p === c[i])) return null;
    }
    let best = candidates[0]!;
    let bestScore = -Infinity;
    for (const cand of candidates) {
      const a = cand.paramNames.filter((p) => p !== "this");
      let score = 0;
      for (let i = 0; i < Math.min(a.length, c.length); i++) if (a[i] === c[i]) score++;
      if (score > bestScore) { bestScore = score; best = cand; }
    }
    return { ref, field: "params", from: c.join(", "), to: best.paramNames.filter((p) => p !== "this").join(", ") };
  }
  return null;
}

/** Build an empty semantic index (for tests). */
export function emptySemanticIndex(): SemanticIndex {
  return { byName: new Map(), records: [], types: new Set(), imports: new Set(), exports: new Set(), paths: new Set() };
}
