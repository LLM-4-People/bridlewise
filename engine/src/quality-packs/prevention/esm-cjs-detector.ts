import { parse } from "@babel/parser";
import { posix } from "node:path";
import { handleError } from "../../shared/debug/debug-system.ts";

import {
  astChildren,
  astNode,
  astNodeArray,
  babelParserPluginsForSourcePath,
  bindingNames,
  type AstNode,
} from "./ast-helpers.ts";

/**
 * ESM/CJS mismatch detector (D3).
 *
 * AST-walk with `@babel/parser` + `babelParserPluginsForSourcePath` (E6).
 * Hand-rolled scope analysis (E4: reuse the `loaderAliases`/`buildScopeAnalysis`
 * pattern from `verification/benchmarks/shared/qualification-authority-inventory.mjs:312-422`;
 * do NOT use `@babel/traverse` — not installed).
 *
 * Detection rules (per the triple-check):
 * 1. `require(...)` in ESM where `require` is NOT a `createRequire`-alias.
 * 2. `__dirname`/`__filename` in a non-type position in ESM.
 * 3. `module.exports =` / `exports.X =` where `module`/`exports` is a free
 * identifier (not a local binding) in ESM.
 * 4. `import`/`export` declarations in `.cjs` files.
 * 5. `import.meta` in `.cjs` files.
 * 6. `.js`-of-`.ts` relative imports: a relative import specifier ending in
 * `.js/.jsx/.mjs/.cjs` whose resolved target is a `.ts/.tsx/.mts/.cts`
 * file in the source set. Correct for THIS project because
 * `tsconfig.json:16` enables `rewriteRelativeImportExtensions: true`
 * (E7). Not applicable to projects using classic/bundler resolution.
 * 7. `createRequire(target)` where `target` resolves to an in-repo
 * `.ts`/`.mjs` ESM source. Permitted: `node:*`, bare npm specifiers,
 * `.json`/`.json5`.
 * 8. `.d.mts` files are ESM-consistent (`import type` from `.mjs`); not
 * flagged for legitimate `import type` usage.
 *
 * Scope (E1): `src/`, `test/`, `scripts/`, `verification/`, `traceability/`.
 * The test passes the source set; the detector has no hardcoded scope.
 */

export type EsmCjsFindingKind =
  | "require-in-esm"
  | "dirname-in-esm"
  | "filename-in-esm"
  | "module-exports-in-esm"
  | "exports-assign-in-esm"
  | "import-in-cjs"
  | "export-in-cjs"
  | "import-meta-in-cjs"
  | "js-of-ts-import"
  | "createRequire-ts-target";

export interface EsmCjsFinding {
  file: string;
  line: number;
  kind: EsmCjsFindingKind;
  detail: string;
}

export interface EsmCjsOptions {
  sources: readonly { path: string; content: string }[];
  allowlist: ReadonlySet<string>;
  createRequirePermittedTargets: ReadonlySet<string>;
}

interface Scope {
  parent: Scope | null;
  bindings: Set<string>;
}

function buildScopeMap(program: AstNode): Map<AstNode, Scope> {
  const scopeOf = new Map<AstNode, Scope>();
  const newScope = (parent: Scope | null): Scope => {
    const scope: Scope = { parent, bindings: new Set<string>() };
    return scope;
  };
  const root: Scope = newScope(null);
  scopeOf.set(program, root);

  function visit(node: AstNode, inherited: Scope): void {
    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
      const fnScope = newScope(inherited);
      scopeOf.set(node, fnScope);
      for (const param of astNodeArray(node.params)) {
        for (const name of bindingNames(astNode(param))) fnScope.bindings.add(name);
      }
      const id = astNode(node.id);
      if (id) visit(id, inherited);
      for (const param of astNodeArray(node.params)) visit(param, fnScope);
      const body = astNode(node.body);
      if (body?.type === "BlockStatement") {
        const blockScope = newScope(fnScope);
        scopeOf.set(body, blockScope);
        visit(body, blockScope);
      } else if (body) {
        scopeOf.set(body, fnScope);
        visit(body, fnScope);
      }
      return;
    }
    if (node.type === "BlockStatement") {
      const blockScope = newScope(inherited);
      scopeOf.set(node, blockScope);
      for (const child of astChildren(node)) visit(child, blockScope);
      return;
    }
    scopeOf.set(node, inherited);
    if (node.type === "VariableDeclaration") {
      for (const declarator of astNodeArray(node.declarations)) {
        for (const name of bindingNames(astNode(declarator.id))) inherited.bindings.add(name);
      }
    } else if (node.type === "ClassDeclaration") {
      const id = astNode(node.id);
      if (id?.type === "Identifier") inherited.bindings.add(String(id.name));
    } else if (node.type === "ImportDeclaration") {
      for (const spec of astNodeArray(node.specifiers)) {
        const local = astNode(spec.local);
        if (local?.type === "Identifier") inherited.bindings.add(String(local.name));
      }
    }
    for (const child of astChildren(node)) visit(child, inherited);
  }

  for (const child of astChildren(program)) visit(child, root);
  return scopeOf;
}

function lookupBinding(scopeOf: Map<AstNode, Scope>, node: AstNode, name: string): boolean {
  let scope: Scope | null = scopeOf.get(node) ?? null;
  while (scope !== null) {
    if (scope.bindings.has(name)) return true;
    scope = scope.parent;
  }
  return false;
}

function isEsm(path: string): boolean {
  return path.endsWith(".ts") || path.endsWith(".tsx") || path.endsWith(".mts") ||
    path.endsWith(".mjs") || path.endsWith(".d.ts") || path.endsWith(".d.mts") || path.endsWith(".d.cts");
}

function isCjs(path: string): boolean {
  return path.endsWith(".cjs") || path.endsWith(".cts");
}

function isDeclaration(path: string): boolean {
  return path.endsWith(".d.ts") || path.endsWith(".d.mts") || path.endsWith(".d.cts");
}

function memberPropertyName(member: AstNode): string | undefined {
  if (!member.computed) {
    const prop = astNode(member.property);
    if (prop?.type === "Identifier") return String(prop.name);
  } else {
    const prop = astNode(member.property);
    if (prop?.type === "StringLiteral") return String(prop.value);
  }
  return undefined;
}

interface CreateRequireFacts {
  createRequireNames: Set<string>;
  moduleNamespaces: Set<string>;
  requireAliases: Set<string>;
}

function collectCreateRequireFacts(program: AstNode): CreateRequireFacts {
  const createRequireNames = new Set<string>();
  const moduleNamespaces = new Set<string>();
  for (const stmt of astNodeArray(program.body)) {
    if (stmt.type !== "ImportDeclaration") continue;
    const source = astNode(stmt.source);
    if (source?.type !== "StringLiteral") continue;
    if (source.value !== "node:module" && source.value !== "module") continue;
    for (const spec of astNodeArray(stmt.specifiers)) {
      const local = astNode(spec.local);
      if (!local || local.type !== "Identifier") continue;
      if (spec.type === "ImportSpecifier") {
        const imported = astNode(spec.imported);
        if (imported?.type === "Identifier" && String(imported.name) === "createRequire") {
          createRequireNames.add(String(local.name));
        }
      } else if (spec.type === "ImportNamespaceSpecifier" || spec.type === "ImportDefaultSpecifier") {
        moduleNamespaces.add(String(local.name));
      }
    }
  }
  // Track `const require = createRequire(import.meta.url)` aliases.
  const requireAliases = new Set<string>();
  let changed = true;
  const declarations: { name: string; init: AstNode | undefined }[] = [];
  for (const stmt of astNodeArray(program.body)) {
    const decl = stmt.type === "ExportNamedDeclaration" ? astNode(stmt.declaration) : stmt;
    if (decl?.type === "VariableDeclaration") {
      for (const declarator of astNodeArray(decl.declarations)) {
        const init = astNode(declarator.init);
        for (const name of bindingNames(astNode(declarator.id))) {
          declarations.push({ name, init });
        }
      }
    }
  }
  while (changed) {
    changed = false;
    for (const { name, init } of declarations) {
      if (requireAliases.has(name)) continue;
      if (init?.type === "Identifier" && requireAliases.has(String(init.name))) {
        requireAliases.add(name);
        changed = true;
      } else if (init?.type === "CallExpression") {
        const callee = astNode(init.callee);
        if (callee?.type === "Identifier" && createRequireNames.has(String(callee.name))) {
          requireAliases.add(name);
          changed = true;
        }
        if ((callee?.type === "MemberExpression" || callee?.type === "OptionalMemberExpression") &&
          astNode(callee.object)?.type === "Identifier" &&
          moduleNamespaces.has(String(astNode(callee.object)!.name)) &&
          memberPropertyName(callee) === "createRequire") {
          requireAliases.add(name);
          changed = true;
        }
      }
    }
  }
  return { createRequireNames, moduleNamespaces, requireAliases };
}

function isCreateRequireCall(
  callee: AstNode | undefined,
  facts: CreateRequireFacts,
): boolean {
  if (callee?.type === "Identifier" && facts.createRequireNames.has(String(callee.name))) return true;
  if ((callee?.type === "MemberExpression" || callee?.type === "OptionalMemberExpression") &&
    astNode(callee.object)?.type === "Identifier" &&
    facts.moduleNamespaces.has(String(astNode(callee.object)!.name)) &&
    memberPropertyName(callee) === "createRequire") {
    return true;
  }
  return false;
}

function isPermittedCreateRequireTarget(
  target: string,
  opts: EsmCjsOptions,
): boolean {
  if (opts.createRequirePermittedTargets.has(target)) return true;
  if (target.startsWith("node:")) return true;
  if (target.endsWith(".json") || target.endsWith(".json5")) return true;
  // Bare npm specifier (no leading "." or "/") — permitted.
  if (!target.startsWith(".") && !target.startsWith("/")) return true;
  // Relative target: permitted unless it resolves to an in-repo.ts/.mjs ESM source.
  if (target.startsWith(".")) {
    // The resolution requires the importing file; handled by the caller.
    return false;
  }
  return true;
}

function resolveRelative(importer: string, specifier: string): string {
  return posix.normalize(posix.join(posix.dirname(importer), specifier));
}

function isTypeOnlyImport(node: AstNode): boolean {
  return node.importKind === "type" || node.exportKind === "type";
}

function inTypePosition(node: AstNode | undefined, ancestors: AstNode[]): boolean {
  if (ancestors.some((a) => a.type === "TSImportType" || a.type === "TSTypeReference" ||
    a.type === "TSTypeAnnotation" || a.type === "TSTypeAliasDeclaration" ||
    a.type === "TSInterfaceDeclaration" || a.type === "TSConditionalType" ||
    a.type === "TSIntersectionType" || a.type === "TSUnionType")) {
    return true;
  }
  return node?.type === "Identifier" && ancestors.some((a) =>
    a.type === "ImportDeclaration" && isTypeOnlyImport(a));
}

function detectInProgram(
  program: AstNode,
  file: string,
  content: string,
  opts: EsmCjsOptions,
  sourcePaths: Set<string>,
  findings: EsmCjsFinding[],
): void {
  const scopeOf = buildScopeMap(program);
  const facts = collectCreateRequireFacts(program);
  const esm = isEsm(file);
  const cjs = isCjs(file);
  const declaration = isDeclaration(file);
  const lineOf = (offset: number): number => {
    let line = 1;
    for (let i = 0; i < offset && i < content.length; i += 1) {
      if (content.charCodeAt(i) === 10) line += 1;
    }
    return line;
  };

  const ancestors: AstNode[] = [];
  function walk(node: AstNode): void {
    // import/export declarations in.cjs files.
    if (cjs && (node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration" ||
      node.type === "ExportDefaultDeclaration" || node.type === "ExportAllDeclaration")) {
      if (!isTypeOnlyImport(node) || node.type !== "ExportNamedDeclaration") {
        const start = typeof node.start === "number" ? node.start : 0;
        findings.push({ file, line: lineOf(start), kind: node.type.startsWith("Export") ? "export-in-cjs" : "import-in-cjs", detail: `${node.type} in .cjs file` });
      }
    }

    // import.meta in.cjs files.
    if (cjs && node.type === "MetaProperty") {
      const meta = astNode(node.meta);
      if (meta?.type === "Identifier" && String(meta.name) === "import") {
        const start = typeof node.start === "number" ? node.start : 0;
        findings.push({ file, line: lineOf(start), kind: "import-meta-in-cjs", detail: "import.meta in .cjs file" });
      }
    }

    // require(...) in ESM where require is NOT a createRequire-alias.
    if (esm && !declaration && (node.type === "CallExpression" || node.type === "OptionalCallExpression")) {
      const callee = astNode(node.callee);
      if (callee?.type === "Identifier" && String(callee.name) === "require" &&
        !facts.requireAliases.has("require") && !lookupBinding(scopeOf, callee, "require")) {
        const start = typeof callee.start === "number" ? callee.start : 0;
        findings.push({ file, line: lineOf(start), kind: "require-in-esm", detail: `require() in ESM ${file}` });
      }
    }

    // createRequire(src)(target) — chained call where target resolves
    // to an in-repo.ts/.mjs ESM source. The outer call's callee is the inner
    // createRequire(src) CallExpression; the target is node.arguments[0].
    if (esm && (node.type === "CallExpression" || node.type === "OptionalCallExpression")) {
      const callee = astNode(node.callee);
      if (callee?.type === "CallExpression" || callee?.type === "OptionalCallExpression") {
        const innerCallee = astNode(callee.callee);
        if (isCreateRequireCall(innerCallee, facts)) {
          const targetArg = astNodeArray(node.arguments)[0];
          if (targetArg?.type === "StringLiteral") {
            const target = String(targetArg.value);
            if (target.startsWith(".") && !isPermittedCreateRequireTarget(target, opts)) {
              const resolved = resolveRelative(file, target);
              const tsExtensions = [".ts", ".tsx", ".mts", ".cts"];
              const tsTargets = tsExtensions.map((ext) => resolved.endsWith(ext) ? resolved : resolved + ext);
              if (tsTargets.some((t) => sourcePaths.has(t))) {
                const start = typeof targetArg.start === "number" ? targetArg.start : 0;
                findings.push({ file, line: lineOf(start), kind: "createRequire-ts-target", detail: `createRequire(${JSON.stringify(target)}) resolves to in-repo ESM source ${resolved}` });
              }
            }
          }
        }
      }
    }

    // __dirname / __filename in ESM (non-type position).
    if (esm && !declaration && node.type === "Identifier") {
      const name = String(node.name);
      if ((name === "__dirname" || name === "__filename") && !lookupBinding(scopeOf, node, name)) {
        if (!inTypePosition(node, ancestors)) {
          const start = typeof node.start === "number" ? node.start : 0;
          findings.push({
            file,
            line: lineOf(start),
            kind: name === "__dirname" ? "dirname-in-esm" : "filename-in-esm",
            detail: `${name} in ESM ${file}`,
          });
        }
      }
    }

    // module.exports = / exports.X = in ESM where module/exports is free.
    if (esm && !declaration && node.type === "AssignmentExpression") {
      const left = astNode(node.left);
      if (left?.type === "MemberExpression" || left?.type === "OptionalMemberExpression") {
        const obj = astNode(left.object);
        if (obj?.type === "Identifier") {
          const objName = String(obj.name);
          if (objName === "module" && !lookupBinding(scopeOf, obj, "module")) {
            const start = typeof node.start === "number" ? node.start : 0;
            findings.push({ file, line: lineOf(start), kind: "module-exports-in-esm", detail: `module.exports assignment in ESM ${file}` });
          } else if (objName === "exports" && !lookupBinding(scopeOf, obj, "exports")) {
            const start = typeof node.start === "number" ? node.start : 0;
            findings.push({ file, line: lineOf(start), kind: "exports-assign-in-esm", detail: `exports.X assignment in ESM ${file}` });
          }
        }
      }
    }

    //.js-of-.ts relative imports.
    if (node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration") {
      const sourceNode = astNode(node.source);
      if (sourceNode?.type === "StringLiteral") {
        const specifier = String(sourceNode.value);
        if (specifier.startsWith(".")) {
          const endsInJsLike = [".js", ".jsx", ".mjs", ".cjs"].some((ext) => specifier.endsWith(ext));
          if (endsInJsLike) {
            const resolved = resolveRelative(file, specifier);
            // Replace the.js/.jsx/.mjs/.cjs extension with.ts/.tsx/.mts/.cts.
            const tsExt = [".js", ".jsx", ".mjs", ".cjs"].find((ext) => specifier.endsWith(ext))!;
            const tsEquivalent = resolved.slice(0, resolved.length - tsExt.length) +
              { ".js": ".ts", ".jsx": ".tsx", ".mjs": ".mts", ".cjs": ".cts" }[tsExt]!;
            if (sourcePaths.has(tsEquivalent)) {
              const start = typeof sourceNode.start === "number" ? sourceNode.start : 0;
              findings.push({
                file,
                line: lineOf(start),
                kind: "js-of-ts-import",
                detail: `import ${JSON.stringify(specifier)} resolves to ${tsEquivalent} (.ts-of-.js rewrite per tsconfig rewriteRelativeImportExtensions)`,
              });
            }
          }
        }
      }
    }

    ancestors.push(node);
    for (const child of astChildren(node)) walk(child);
    ancestors.pop();
  }

  walk(program);
}

export function detectEsmCjsMismatches(opts: EsmCjsOptions): readonly EsmCjsFinding[] {
  const findings: EsmCjsFinding[] = [];
  const sourcePaths = new Set(opts.sources.map((s) => s.path));
  for (const src of opts.sources) {
    if (opts.allowlist.has(src.path)) continue;
    let program: AstNode;
    try {
      const parsed = parse(src.content, {
        sourceType: "module",
        plugins: [...babelParserPluginsForSourcePath(src.path)],
      });
      program = parsed.program as unknown as AstNode;
    } catch (e) {handleError(e, { module: "quality-packs-prevention-esm-cjs-detector", operation: "catch" });
      // Unparseable source: skip (reported by other guards).
      continue;
    }
    detectInProgram(program, src.path, src.content, opts, sourcePaths, findings);
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
