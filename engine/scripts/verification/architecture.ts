import { posix } from "node:path";

import { astChildren, astNode, astNodeArray, parseSourceModule, type AstNode } from "../../src/quality-packs/prevention/ast-helpers.ts";

import {
  ARCHITECTURE_MANIFEST,
  type ArchitectureAuthorityFamily,
  type ArchitectureEffect,
  type ArchitectureManifest,
  type ArchitectureModule,
  type ArchitectureRealm,
} from "../../src/architecture-manifest.ts";
import { canonicalHash, deepFreeze, sha256 } from "../../src/kernel/integrity.ts";
import { isPlainObject } from "../../src/shared/type-guards.ts";
import { sameOrderedValues } from "../../src/kernel/ordered.ts";
import { repositoryScanExclusionFor } from "../../src/shared/source-scan.ts";
import { DEFAULT_ARCHITECTURE_SOURCE_CACHE_MAX_ENTRIES } from "../../src/workflow/workflow-config.ts";
import {
  canonicalFilesystemModuleSpecifier,
  classifyProcessInvocation,
  classifyShellCommand,
  classifyFilesystemApi,
  classifyFilesystemOpenFlagTokens,
  dependencyEffects,
  isFilesystemModuleSpecifier,
  isGitExecutable,
  isRuntimeExecutionApi,
  type FilesystemOpenMode,
} from "./effect-surface.ts";
import { analyzeStaticModuleShape } from "./static-source.ts";

export type ArchitectureSource = Readonly<{ path: string; source: string }>;
export type ArchitectureVerification = Readonly<{
  ok: boolean;
  graphHash: string;
  violations: readonly string[];
}>;

type DeclaredName = Readonly<{
  name: string;
  kind: string;
  extendsGlobalError: boolean;
}>;
export type ArchitectureSourceFacts = Readonly<{
  dependencies: readonly string[];
  /**
   * Erased module references (type imports, exports and import types), kept apart from `dependencies`
   * because they carry no runtime edge — the module graph, the effect model
   * and the manifest are all about what actually executes, and folding these
   * in would rewrite every module's dependency list to describe something
   * else. They are recorded rather than discarded because a type import still
   * puts the file in the compiler's program: it is a claim that the target is
   * part of this source tree, and it is enough to reach outside one.
   */
  typeOnlyDependencies: readonly string[];
  importedSymbols: readonly Readonly<{ importedName: string; localName: string; source: string }>[];
  exportedNames: readonly string[];
  declaredNames: readonly DeclaredName[];
  constructedTypes: readonly string[];
  directEffectFacts: readonly DirectEffectFact[];
  unmodeledEffects: readonly string[];
  directExecutionEntrypoint: boolean;
  topLevelExecution: boolean;
  nodeCount: number;
}>;
export type DirectEffectFact = Readonly<{
  ownerLabel: string;
  effects: readonly ArchitectureEffect[];
}>;
type ModuleValue = Readonly<{
  kind: "loader" | "member" | "namespace";
  member?: string;
  source?: string;
}>;
type ModuleBindingState = Readonly<{
  bindings: Map<string, ModuleValue>;
  carrierReasons: Map<string, string>;
  constantInitializers: ReadonlyMap<string, AstNode>;
  mutatedNames: ReadonlySet<string>;
}>;
type ModuleDeclarator = Readonly<{ declarator: AstNode; mutable: boolean }>;

const ALLOWED_BOUNDARY_EFFECTS: Readonly<Record<ArchitectureModule["executionBoundary"],
  readonly ArchitectureEffect[]>> = deepFreeze({
    pure: ["cryptography"],
    "read-adapter": ["cryptography", "filesystem-read"],
    "effect-adapter": [
      "child-process", "cryptography", "environment-access", "filesystem-read", "filesystem-write", "git", "network", "process-control", "process-status",
    ],
    interface: ["environment-access", "process-status"],
    "composition-root": [
      "child-process", "cryptography", "environment-access", "filesystem-read", "filesystem-write", "git", "network", "process-control", "process-status",
    ],
    verification: [
      "child-process", "cryptography", "environment-access", "filesystem-read", "filesystem-write", "git", "network", "process-control", "process-status",
    ],
  });

const INTERNAL_IMPORT_POLICIES = deepFreeze([{
  id: "filesystem",
  path: "src/filesystem/durable-filesystem-internal.ts",
  allowedImporters: [
    "src/filesystem/immutable-receipt.ts",
    "src/filesystem/durable-filesystem.ts",
  ],
  deniedNames: ["withCurrentNodeRuntimeForFilesystemMechanismTest", "*"],
}, {
  id: "pinned-process",
  path: "src/process/pinned-process-internal.ts",
  allowedImporters: ["src/filesystem/durable-filesystem-internal.ts", "src/runtime/admitted-node-runtime.ts", "src/git/git-adapter.ts", "scripts/tooling/repository-git.ts"],
  deniedNames: ["*"],
}, {
  id: "root-capability-internal",
  path: "src/filesystem/repository-root-capability-internal.ts",
  allowedImporters: ["scripts/verification/safe-repository-reader.ts"],
  deniedNames: [],
}] as const);

// Content-hash memoization of analyzeArchitectureSource. The function is a
// pure function of (path, source): it Babel-parses the source + derives
// ArchitectureSourceFacts with no side effects. Candidates created by
// makeRuntimeCandidate share the same file contents as the repository
// (copy-on-write reflinks), so a mutated candidate that changed only one
// file hits the cache for every OTHER file — collapsing the per-candidate
// Babel-parse cost from ~5s (parse every source file) to ~0.1s (only the
// mutated file is re-parsed). The cache is module-level so it persists
// across verifyS1Structure calls within the same process. Bounded by FIFO
// eviction; the number of distinct source files is ~200, well under the cap.
//
// The serial test phase uses process isolation, so the in-memory cache is
// per-process. The FILESYSTEM-BACKED cache (shared across all processes on
// the machine) lets the first process to analyze a given (path, source)
// share its result with the rest. This collapses the per-candidate Babel
// parse across the ~10 serial processes: the first process parses + writes;
// the rest read the cached result. Best-effort: a filesystem failure falls
// through to computation.
//
// The cache key carries the analyzer's OWN BYTES as its salt (this module,
// plus effect-surface.ts — the classifier + Babel-plugin-selection module
// the facts derivation calls into): the facts are a function of the source
// AND the analyzer, so an entry written before the analyzer's behavior
// changed must never be read back after — a stale entry would mask the
// change, silently serving pre-change facts (a fixed analyzer answering
// from before the fix, the same stale-key class the lexical shape cache
// closed). Change either module and every key changes with it. The shared
// source identity must be available before either result cache is accessed.
// Unavailable source bytes cause fresh computation without cache reads/writes.
const ARCHITECTURE_SOURCE_CACHE_MAX_ENTRIES = DEFAULT_ARCHITECTURE_SOURCE_CACHE_MAX_ENTRIES;
const architectureSourceCache = new Map<string, ArchitectureSourceFacts>();

import { createFilesystemCache, analysisSemanticsId } from "./filesystem-cache.ts";
import { DEFAULT_ARCHITECTURE_SOURCE_FILESYSTEM_CACHE_MAX_ENTRIES } from "../../src/workflow/workflow-config.ts";

const architectureSourceFilesystemCache = createFilesystemCache({
  directory: "harness-arch-cache",
  maxEntries: DEFAULT_ARCHITECTURE_SOURCE_FILESYSTEM_CACHE_MAX_ENTRIES,
});

const ARCHITECTURE_EFFECT_NAMES: ReadonlySet<string> = new Set(Object.values(ALLOWED_BOUNDARY_EFFECTS).flat());

function validateArchitectureSourceFacts(value: unknown): ArchitectureSourceFacts | undefined {
  if (!isPlainObject(value)) return undefined;
  for (const field of ["dependencies", "typeOnlyDependencies", "exportedNames", "constructedTypes", "unmodeledEffects"]) {
    const entries = value[field];
    if (!Array.isArray(entries) || !entries.every((entry) => typeof entry === "string")) return undefined;
  }
  if (!Array.isArray(value.importedSymbols) || !value.importedSymbols.every((entry) =>
    isPlainObject(entry) && typeof entry.importedName === "string" &&
    typeof entry.localName === "string" && typeof entry.source === "string")) return undefined;
  if (!Array.isArray(value.declaredNames) || !value.declaredNames.every((entry) =>
    isPlainObject(entry) && typeof entry.name === "string" && typeof entry.kind === "string" &&
    typeof entry.extendsGlobalError === "boolean")) return undefined;
  if (!Array.isArray(value.directEffectFacts) || !value.directEffectFacts.every((entry) =>
    isPlainObject(entry) && typeof entry.ownerLabel === "string" && Array.isArray(entry.effects) &&
    entry.effects.every((effect) => typeof effect === "string" && ARCHITECTURE_EFFECT_NAMES.has(effect)))) return undefined;
  if (typeof value.directExecutionEntrypoint !== "boolean" || typeof value.topLevelExecution !== "boolean" ||
    typeof value.nodeCount !== "number" || !Number.isSafeInteger(value.nodeCount) || value.nodeCount < 0) return undefined;
  // The producer's maximum+1 node count is a valid budget-refusal fact.
  return value as unknown as ArchitectureSourceFacts;
}

export function clearArchitectureSourceCache(): void {
  architectureSourceCache.clear();
}

export function analyzeArchitectureSource(path: string, source: string): ArchitectureSourceFacts {
  const contentHash = sha256(Buffer.from(source, "utf8"));
  const semanticsId = analysisSemanticsId(import.meta.url, new URL("./effect-surface.ts", import.meta.url));
  const cacheKey = semanticsId === undefined ? undefined : `${path}\u0000${contentHash}\u0000${semanticsId}`;
  const cached = cacheKey === undefined ? undefined : architectureSourceCache.get(cacheKey);
  if (cached !== undefined) return cached;
  // Filesystem-backed cache: shared across serial-phase processes. The
  // in-memory cache is per-process (isolation: "process"), so each serial
  // process re-parses from scratch on a cold in-memory cache. The filesystem
  // cache (keyed by path + content hash + the analyzer's own bytes) lets
  // the first process to analyze a given (path, source) share its result
  // with the rest.
  const filesystemCached = cacheKey === undefined ? undefined : architectureSourceFilesystemCache.read<ArchitectureSourceFacts>(cacheKey, validateArchitectureSourceFacts);
  if (cacheKey !== undefined && filesystemCached !== undefined) {
    architectureSourceCache.set(cacheKey, filesystemCached);
    return filesystemCached;
  }
  const program = parseSourceModule(path, source, { errorRecovery: false, attachComment: false, tokens: false });
  const dependencies: string[] = [];
  const typeOnlyDependencies: string[] = [];
  const exportedNames: string[] = [];
  const declaredNames: DeclaredName[] = [];
  const constructedTypes: string[] = [];
  const importedBindings = new Map<string, ModuleValue>();
  const constantInitializers = new Map<string, AstNode>();
  const moduleDeclarators: ModuleDeclarator[] = [];
  const calls: AstNode[] = [];
  const members: AstNode[] = [];
  const dynamicFilesystemSources: string[] = [];
  const unmodeledModuleAcquisitions: string[] = [];
  const mutatedNames = collectMutatedArchitectureNames(program);
  const pending = [{ node: program, erasedAncestor: false }];
  const visited = new Set<AstNode>();
  let nodeCount = 0;
  let directExecutionEntrypoint = false;
  while (pending.length > 0) {
    const entry = pending.pop()!;
    const node = entry.node;
    // Ambient declarations are erased as a whole, before strip-only checks
    // on their children. Still traverse them for source/API reference census.
    const erasedAncestor = entry.erasedAncestor || node.declare === true ||
      (node.type === "TSModuleDeclaration" && (astNode(node.id)?.type === "StringLiteral" || node.global === true));
    if (visited.has(node)) continue;
    visited.add(node);
    nodeCount += 1;
    if (nodeCount > ARCHITECTURE_MANIFEST.analysisLimits.maximumAstNodes) break;
    if (["ImportDeclaration", "ExportAllDeclaration", "ExportNamedDeclaration"].includes(node.type)) {
      const sourceNode = astNode(node.source);
      if (sourceNode?.type === "StringLiteral") {
        const specifier = resolveSpecifier(path, String(sourceNode.value));
        const erased = erasedAncestor || (node.type === "ImportDeclaration" ? node.importKind === "type" : node.exportKind === "type");
        (erased ? typeOnlyDependencies : dependencies).push(specifier);
        if (!erased && node.type === "ImportDeclaration") registerImportBindings(node, specifier, importedBindings);
      }
    }
    if (node.type === "TSImportEqualsDeclaration") {
      if (!erasedAncestor && node.importKind !== "type") throw new Error("unsupported TypeScript import-equals in strip-only profile");
      const reference = astNode(node.moduleReference);
      const sourceNode = astNode(reference?.expression);
      if (reference?.type === "TSExternalModuleReference" && sourceNode?.type === "StringLiteral") {
        typeOnlyDependencies.push(resolveSpecifier(path, String(sourceNode.value)));
      }
    }
    if (!erasedAncestor && node.type === "TSExportAssignment") throw new Error("unsupported TypeScript export assignment in strip-only profile");
    if (!erasedAncestor && node.type === "TSTypeAssertion") throw new Error("unsupported TypeScript angle-bracket assertion in strip-only profile");
    if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
      if (!erasedAncestor) calls.push(node);
      const callee = astNode(node.callee);
      const argumentsList = astNodeArray(node.arguments);
      if (callee?.type === "Import" && argumentsList[0]?.type === "StringLiteral") {
        const specifier = String(argumentsList[0].value);
        (erasedAncestor ? typeOnlyDependencies : dependencies).push(resolveSpecifier(path, specifier));
        if (!erasedAncestor && isFilesystemModuleSpecifier(specifier)) dynamicFilesystemSources.push(specifier);
      } else if (callee?.type === "Import") {
        unmodeledModuleAcquisitions.push("dynamic-import");
      }
    }
    if (node.type === "ImportExpression") {
      const sourceNode = astNode(node.source);
      if (sourceNode?.type === "StringLiteral") {
        const specifier = String(sourceNode.value);
        (erasedAncestor ? typeOnlyDependencies : dependencies).push(resolveSpecifier(path, specifier));
        if (!erasedAncestor && isFilesystemModuleSpecifier(specifier)) dynamicFilesystemSources.push(specifier);
      } else {
        unmodeledModuleAcquisitions.push("dynamic-import");
      }
    }
    if (node.type === "TSImportType") {
      const sourceNode = astNode(node.source);
      if (sourceNode?.type === "StringLiteral") {
        typeOnlyDependencies.push(resolveSpecifier(path, String(sourceNode.value)));
      }
    }
    if (node.type === "ExportDefaultDeclaration") exportedNames.push("default");
    if (node.type === "ExportNamedDeclaration") {
      const declaration = astNode(node.declaration);
      exportedNames.push(...declarationExportNames(declaration));
      for (const specifier of astNodeArray(node.specifiers)) {
        const exported = astNode(specifier.exported);
        if (exported?.type === "Identifier" || exported?.type === "StringLiteral") {
          exportedNames.push(String(exported.name ?? exported.value));
        }
      }
    }
    const declaration = declaredAstName(node);
    if (declaration) declaredNames.push(declaration);
    if (!erasedAncestor && node.type === "VariableDeclaration") {
      for (const declarator of astNodeArray(node.declarations)) {
        moduleDeclarators.push({ declarator, mutable: node.kind !== "const" });
        const identifier = astNode(declarator.id);
        const initializer = astNode(declarator.init);
        if (node.kind === "const" && identifier?.type === "Identifier" && initializer &&
          !mutatedNames.has(String(identifier.name))) {
          constantInitializers.set(String(identifier.name), initializer);
        }
      }
    }
    if (!erasedAncestor && node.type === "AssignmentExpression" && node.operator === "=") {
      const target = astNode(node.left);
      const initializer = astNode(node.right);
      if (target && initializer) {
        moduleDeclarators.push({
          declarator: { type: "VariableDeclarator", id: target, init: initializer },
          mutable: true,
        });
      }
    }
    if (!erasedAncestor && (node.type === "MemberExpression" || node.type === "OptionalMemberExpression")) members.push(node);
    if (!erasedAncestor && node.type === "BinaryExpression" && node.operator === "===" &&
      astContainsStaticMember(node, "import.meta.url") && astContainsStaticMember(node, "process.argv")) {
      directExecutionEntrypoint = true;
    }
    // THE one main-ness test (`isEntryPoint(import.meta.url)`, src/runtime/cli-debug.ts):
    // every entry point of this repository spells its guard this way.
    if (!erasedAncestor && node.type === "CallExpression" && staticCalleeName(astNode(node.callee)) === "isEntryPoint" &&
      astContainsStaticMember(node, "import.meta.url")) {
      directExecutionEntrypoint = true;
    }
    if (!erasedAncestor && node.type === "NewExpression") {
      const constructed = staticCalleeName(astNode(node.callee));
      if (constructed) constructedTypes.push(constructed);
    }
    pending.push(...astChildren(node).map(child => ({ node: child, erasedAncestor })));
  }
  const bindingState = buildModuleBindings(
    importedBindings,
    constantInitializers,
    moduleDeclarators,
    mutatedNames,
  );
  for (const call of calls) {
    const specifier = moduleAcquisitionSpecifier(call, bindingState);
    if (specifier !== undefined) dependencies.push(resolveSpecifier(path, specifier));
  }
  const directEffects = architectureDirectEffects(path, bindingState, calls, members, dynamicFilesystemSources);
  const importedSymbols = [...importedBindings.entries()].map(([localName, value]) => ({
    importedName: value.kind === "namespace" ? "*" : value.member ?? "default",
    localName,
    source: value.source ?? "unknown",
  })).toSorted((left, right) =>
    left.source.localeCompare(right.source) || left.importedName.localeCompare(right.importedName) ||
    left.localName.localeCompare(right.localName)
  );
  const result = deepFreeze({
    dependencies: [...new Set(dependencies)].toSorted(),
    typeOnlyDependencies: [...new Set(typeOnlyDependencies)].toSorted(),
    importedSymbols,
    exportedNames: [...new Set(exportedNames)].toSorted(),
    declaredNames,
    constructedTypes: [...new Set(constructedTypes)].toSorted(),
    directEffectFacts: directEffects.facts,
    unmodeledEffects: [...new Set([...directEffects.unmodeled, ...unmodeledModuleAcquisitions])].toSorted(),
    directExecutionEntrypoint: directExecutionEntrypoint ||
      hasImportSafeDirectExecutionGuard(program, constantInitializers),
    topLevelExecution: hasTopLevelExecution(program),
    nodeCount,
  });
  if (cacheKey !== undefined) {
    if (architectureSourceCache.size >= ARCHITECTURE_SOURCE_CACHE_MAX_ENTRIES) {
      const oldest = architectureSourceCache.keys().next();
      if (!oldest.done) architectureSourceCache.delete(oldest.value);
    }
    architectureSourceCache.set(cacheKey, result);
    architectureSourceFilesystemCache.write(cacheKey, result);
  }
  return result;
}

function hasTopLevelExecution(program: AstNode): boolean {
  for (const statement of astNodeArray(program.body)) {
    const declaration = statement.type === "ExportNamedDeclaration" ||
      statement.type === "ExportDefaultDeclaration"
      ? astNode(statement.declaration)
      : statement;
    if (!declaration || [
      "ImportDeclaration", "ExportAllDeclaration", "FunctionDeclaration", "ClassDeclaration",
      "TSDeclareFunction", "TSInterfaceDeclaration", "TSTypeAliasDeclaration", "TSEnumDeclaration",
      "TSModuleDeclaration", "DeclareVariable", "DeclareFunction", "DeclareClass", "EmptyStatement",
    ].includes(declaration.type)) continue;
    if (declaration.type === "VariableDeclaration") {
      if (astNodeArray(declaration.declarations).some((candidate) => {
        const initializer = astNode(candidate.init);
        return initializer !== undefined && containsTopLevelRuntimeExpression(initializer);
      })) return true;
      continue;
    }
    if (declaration.type === "ExpressionStatement") {
      const expression = astNode(declaration.expression);
      if (expression && containsTopLevelRuntimeExpression(expression)) return true;
      continue;
    }
    return true;
  }
  return false;
}

function containsTopLevelRuntimeExpression(root: AstNode): boolean {
  const pending = [root];
  const visited = new Set<AstNode>();
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);
    if ([
      "CallExpression", "OptionalCallExpression", "NewExpression", "ImportExpression",
      "AwaitExpression", "YieldExpression", "AssignmentExpression", "UpdateExpression",
      "TaggedTemplateExpression",
    ].includes(node.type)) return true;
    if (["FunctionExpression", "ArrowFunctionExpression", "ClassExpression"].includes(node.type)) continue;
    pending.push(...astChildren(node));
  }
  return false;
}

function hasImportSafeDirectExecutionGuard(
  program: AstNode,
  constantInitializers: ReadonlyMap<string, AstNode>,
): boolean {
  const pending = [program];
  const visited = new Set<AstNode>();
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);
    if (node.type === "IfStatement") {
      const test = astNode(node.test);
      if (test && hasDirectExecutionIdentityComparison(test, constantInitializers)) return true;
    }
    pending.push(...astChildren(node));
  }
  return false;
}

function hasDirectExecutionIdentityComparison(
  expression: AstNode,
  constantInitializers: ReadonlyMap<string, AstNode>,
): boolean {
  const pending = [expression];
  const visited = new Set<AstNode>();
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);
    if (node.type === "BinaryExpression" && node.operator === "===") {
      const left = astNode(node.left);
      const right = astNode(node.right);
      if (left && right) {
        const leftArgv = astTransitivelyContainsStaticMember(left, "process.argv", constantInitializers);
        const rightArgv = astTransitivelyContainsStaticMember(right, "process.argv", constantInitializers);
        const leftModule = astTransitivelyContainsStaticMember(left, "import.meta.url", constantInitializers);
        const rightModule = astTransitivelyContainsStaticMember(right, "import.meta.url", constantInitializers);
        if ((leftArgv && rightModule) || (rightArgv && leftModule)) return true;
      }
    }
    pending.push(...astChildren(node));
  }
  return false;
}

function astTransitivelyContainsStaticMember(
  root: AstNode,
  expected: string,
  constantInitializers: ReadonlyMap<string, AstNode>,
  active = new Set<string>(),
): boolean {
  const pending = [root];
  const visited = new Set<AstNode>();
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);
    if (staticMemberPath(node) === expected) return true;
    if (node.type === "Identifier") {
      const name = String(node.name);
      const initializer = constantInitializers.get(name);
      if (initializer && !active.has(name)) {
        active.add(name);
        if (astTransitivelyContainsStaticMember(initializer, expected, constantInitializers, active)) return true;
        active.delete(name);
      }
    }
    pending.push(...astChildren(node));
  }
  return false;
}

function registerImportBindings(
  declaration: AstNode,
  source: string,
  bindings: Map<string, ModuleValue>,
): void {
  if (declaration.importKind === "type") return;
  for (const specifier of astNodeArray(declaration.specifiers)) {
    if (specifier.importKind === "type") continue;
    const local = astNode(specifier.local);
    if (local?.type !== "Identifier") continue;
    if (specifier.type === "ImportDefaultSpecifier" || specifier.type === "ImportNamespaceSpecifier") {
      bindings.set(String(local.name), { kind: "namespace", source });
      continue;
    }
    const imported = astNode(specifier.imported);
    if (imported?.type === "Identifier" || imported?.type === "StringLiteral") {
      const importedName = String(imported.name ?? imported.value);
      if (canonicalFilesystemModuleSpecifier(source) === "node:fs" && importedName === "promises") {
        bindings.set(String(local.name), { kind: "namespace", source: "node:fs/promises" });
        continue;
      }
      bindings.set(String(local.name), {
        kind: "member",
        source,
        member: importedName,
      });
    }
  }
}

function buildModuleBindings(
  importedBindings: ReadonlyMap<string, ModuleValue>,
  constantInitializers: ReadonlyMap<string, AstNode>,
  declarators: readonly ModuleDeclarator[],
  mutatedNames: ReadonlySet<string>,
): ModuleBindingState {
  const bindings = new Map(importedBindings);
  const carrierReasons = new Map<string, string>();
  for (const name of mutatedNames) {
    if (bindings.has(name)) carrierReasons.set(name, `mutated-carrier-${name}`);
  }
  const state: ModuleBindingState = { bindings, carrierReasons, constantInitializers, mutatedNames };
  for (let pass = 0; pass <= declarators.length; pass += 1) {
    let changed = false;
    for (const entry of declarators) {
      const declarator = entry.declarator;
      const pattern = astNode(declarator.id);
      const initializer = astNode(declarator.init);
      if (!pattern || !initializer) continue;
      if (pattern.type === "Identifier") {
        const name = String(pattern.name);
        const value = resolveModuleValue(initializer, state);
        if (value && !sameModuleValue(bindings.get(name), value)) {
          bindings.set(name, value);
          changed = true;
        }
        if (value && (entry.mutable || mutatedNames.has(name))) {
          carrierReasons.set(name, `${entry.mutable ? "mutable" : "mutated"}-carrier-${name}`);
        }
        if (!value) {
          const [source] = unmodeledFilesystemCarrierSources(initializer, state);
          if (source !== undefined) {
            const carrier: ModuleValue = { kind: "namespace", source };
            if (!sameModuleValue(bindings.get(name), carrier)) {
              bindings.set(name, carrier);
              changed = true;
            }
            carrierReasons.set(name, `unmodeled-expression-carrier-${name}`);
          }
        }
        continue;
      }
      if (pattern.type !== "ObjectPattern") {
        const [source] = unmodeledFilesystemCarrierSources(initializer, state);
        if (source !== undefined) {
          for (const name of bindingNames(pattern)) {
            const carrier: ModuleValue = { kind: "namespace", source };
            if (!sameModuleValue(bindings.get(name), carrier)) {
              bindings.set(name, carrier);
              changed = true;
            }
            carrierReasons.set(name, `unmodeled-pattern-carrier-${name}`);
          }
        }
        continue;
      }
      const namespace = resolveModuleValue(initializer, state);
      if (namespace?.kind !== "namespace" || namespace.source === undefined) continue;
      changed = registerDestructuredModuleBindings(
        pattern,
        namespace,
        entry.mutable,
        state,
      ) || changed;
    }
    if (!changed) break;
  }
  return state;
}

function registerDestructuredModuleBindings(
  pattern: AstNode,
  namespace: ModuleValue,
  mutable: boolean,
  state: ModuleBindingState,
): boolean {
  if (namespace.source === undefined) return false;
  let changed = false;
  for (const property of astNodeArray(pattern.properties)) {
    if (property.type === "RestElement") {
      const argument = astNode(property.argument);
      if (argument?.type !== "Identifier") continue;
      const name = String(argument.name);
      if (!sameModuleValue(state.bindings.get(name), namespace)) {
        state.bindings.set(name, namespace);
        changed = true;
      }
      state.carrierReasons.set(name, `rest-carrier-${name}`);
      continue;
    }
    if (property.type !== "ObjectProperty") continue;
    const member = architecturePropertyName(property, state);
    const target = astNode(property.value);
    if (!target) continue;
    if (member === undefined) {
      for (const name of bindingNames(target)) {
        const carrier: ModuleValue = { kind: "namespace", source: namespace.source };
        if (!sameModuleValue(state.bindings.get(name), carrier)) {
          state.bindings.set(name, carrier);
          changed = true;
        }
        state.carrierReasons.set(name, `dynamic-destructure-carrier-${name}`);
      }
      continue;
    }
    const memberValue = moduleMemberValue(namespace, namespace.source, member);
    const assignmentTarget = target.type === "AssignmentPattern" ? astNode(target.left) : target;
    if (assignmentTarget?.type === "Identifier") {
      const name = String(assignmentTarget.name);
      if (!sameModuleValue(state.bindings.get(name), memberValue)) {
        state.bindings.set(name, memberValue);
        changed = true;
      }
      if (mutable || state.mutatedNames.has(name)) {
        state.carrierReasons.set(
          name,
          `${mutable ? "mutable" : "mutated"}-carrier-${name}`,
        );
      }
      continue;
    }
    if (assignmentTarget?.type === "ObjectPattern" && memberValue.kind === "namespace") {
      changed = registerDestructuredModuleBindings(
        assignmentTarget,
        memberValue,
        mutable,
        state,
      ) || changed;
    }
  }
  return changed;
}

function unmodeledFilesystemCarrierSources(
  input: AstNode,
  state: ModuleBindingState,
  active = new Set<AstNode>(),
): readonly string[] {
  const node = unwrapArchitectureExpression(input);
  if (!node || active.has(node)) return [];
  active.add(node);
  try {
    const exact = resolveModuleValue(node, state);
    if (exact?.source !== undefined && isFilesystemModuleSpecifier(exact.source)) {
      return [canonicalFilesystemModuleSpecifier(exact.source)!];
    }
    const candidates: AstNode[] = [];
    if (node.type === "ConditionalExpression") {
      candidates.push(...astNodeArray([node.consequent, node.alternate]));
    } else if (node.type === "LogicalExpression" || node.type === "SequenceExpression") {
      candidates.push(...astNodeArray(node.expressions ?? [node.left, node.right]));
    } else if (node.type === "ObjectExpression") {
      for (const property of astNodeArray(node.properties)) {
        if (property.type === "ObjectProperty") {
          const value = astNode(property.value);
          if (value) candidates.push(value);
        } else if (property.type === "SpreadElement") {
          const argument = astNode(property.argument);
          if (argument) candidates.push(argument);
        }
      }
    } else if (node.type === "ArrayExpression") {
      for (const element of astNodeArray(node.elements)) {
        const value = element.type === "SpreadElement" ? astNode(element.argument) : element;
        if (value) candidates.push(value);
      }
    } else if (node.type === "ArrowFunctionExpression") {
      const body = astNode(node.body);
      if (body?.type !== "BlockStatement" && body) candidates.push(body);
      else if (body) candidates.push(...returnedExpressions(body));
    } else if (node.type === "FunctionExpression") {
      const body = astNode(node.body);
      if (body) candidates.push(...returnedExpressions(body));
    }
    const sources = candidates.flatMap((candidate) =>
      unmodeledFilesystemCarrierSources(candidate, state, active)
    );
    return [...new Set(sources)].toSorted();
  } finally {
    active.delete(node);
  }
}

function returnedExpressions(body: AstNode): readonly AstNode[] {
  const output: AstNode[] = [];
  const pending = [...astChildren(body)];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression") continue;
    if (node.type === "ReturnStatement") {
      const argument = astNode(node.argument);
      if (argument) output.push(argument);
      continue;
    }
    pending.push(...astChildren(node));
  }
  return output;
}

function sameModuleValue(left: ModuleValue | undefined, right: ModuleValue): boolean {
  return left?.kind === right.kind && left.source === right.source && left.member === right.member;
}

function moduleMemberValue(objectValue: ModuleValue, source: string, member: string): ModuleValue {
  if (objectValue.kind === "namespace") {
    const filesystemSource = canonicalFilesystemModuleSpecifier(source);
    if (filesystemSource === "node:fs" && member === "promises") {
      return { kind: "namespace", source: "node:fs/promises" };
    }
    return { kind: "member", source, member };
  }
  return {
    kind: "member",
    source,
    member: `${objectValue.member ?? "unknown"}.${member}`,
  };
}

function resolveModuleValue(
  input: AstNode,
  state: ModuleBindingState,
  active = new Set<AstNode>(),
): ModuleValue | undefined {
  const node = unwrapArchitectureExpression(input);
  if (!node || active.has(node)) return undefined;
  active.add(node);
  try {
    if (node.type === "Identifier") {
      const name = String(node.name);
      const binding = state.bindings.get(name);
      if (binding) return binding;
      if (state.mutatedNames.has(name)) return undefined;
      if (name === "require") return { kind: "loader" };
      if (name === "process") return { kind: "namespace", source: "node:process" };
      const initializer = state.constantInitializers.get(name);
      return initializer ? resolveModuleValue(initializer, state, active) : undefined;
    }
    if (node.type === "ImportExpression") {
      const sourceNode = astNode(node.source);
      const source = sourceNode ? resolveStaticArchitectureString(sourceNode, state) : undefined;
      return source === undefined ? undefined : { kind: "namespace", source };
    }
    if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
      const specifier = moduleAcquisitionSpecifier(node, state);
      if (specifier !== undefined) return { kind: "namespace", source: specifier };
      const callee = astNode(node.callee);
      const calleeValue = callee ? resolveModuleValue(callee, state, active) : undefined;
      return calleeValue?.kind === "member" && calleeValue.source === "node:module" &&
        calleeValue.member === "createRequire"
        ? { kind: "loader" }
        : undefined;
    }
    if (node.type !== "MemberExpression" && node.type !== "OptionalMemberExpression") return undefined;
    const object = astNode(node.object);
    const member = architecturePropertyName(node, state);
    if (!object || member === undefined) return undefined;
    const directObject = unwrapArchitectureExpression(object);
    if (directObject?.type === "ImportExpression" && ["catch", "finally", "then"].includes(member)) {
      return undefined;
    }
    const objectValue = resolveModuleValue(object, state, active);
    if (!objectValue || objectValue.kind === "loader" || objectValue.source === undefined) return undefined;
    return moduleMemberValue(objectValue, objectValue.source, member);
  } finally {
    active.delete(node);
  }
}

function moduleAcquisitionSpecifier(call: AstNode, state: ModuleBindingState): string | undefined {
  const argumentsList = astNodeArray(call.arguments);
  const first = argumentsList[0];
  if (!first) return undefined;
  const callee = unwrapArchitectureExpression(astNode(call.callee));
  if (!callee) return undefined;
  if (callee.type === "Import") return resolveStaticArchitectureString(first, state);
  if (isProcessGetBuiltinModuleCallee(callee, state)) return resolveStaticArchitectureString(first, state);
  const calleeValue = resolveModuleValue(callee, state);
  if (calleeValue?.kind === "member" && calleeValue.source === "node:process" &&
    calleeValue.member === "getBuiltinModule") {
    return resolveStaticArchitectureString(first, state);
  }
  return calleeValue?.kind === "loader" ? resolveStaticArchitectureString(first, state) : undefined;
}

function isProcessGetBuiltinModuleCallee(callee: AstNode, state: ModuleBindingState): boolean {
  if (callee.type !== "MemberExpression" && callee.type !== "OptionalMemberExpression") return false;
  if (architecturePropertyName(callee, state) !== "getBuiltinModule") return false;
  const object = unwrapArchitectureExpression(astNode(callee.object));
  if (!object) return false;
  const objectPath = staticMemberPath(object);
  if (objectPath === "process" || objectPath === "globalThis.process") return true;
  const value = resolveModuleValue(object, state);
  return value?.kind === "namespace" && value.source === "node:process";
}

function architectureDirectEffects(
  sourcePath: string,
  state: ModuleBindingState,
  calls: readonly AstNode[],
  members: readonly AstNode[],
  dynamicFilesystemSources: readonly string[],
): Readonly<{ facts: readonly DirectEffectFact[]; unmodeled: readonly string[] }> {
  const effectFacts = new Map<string, Set<ArchitectureEffect>>();
  const unmodeled = new Set<string>();
  const addFact = (ownerLabel: string, effects: readonly ArchitectureEffect[]): void => {
    if (effects.length === 0) return;
    const existing = effectFacts.get(ownerLabel) ?? new Set<ArchitectureEffect>();
    for (const effect of effects) existing.add(effect);
    effectFacts.set(ownerLabel, existing);
  };
  const addUnmodeledFilesystem = (source: string, reason: string): void => {
    const canonicalSource = canonicalFilesystemModuleSpecifier(source) ?? source;
    addFact(canonicalSource, ["filesystem-read", "filesystem-write"]);
    unmodeled.add(`${canonicalSource}:${reason}`);
  };
  const classifyFilesystemMember = (
    source: string,
    member: string,
    openMode?: FilesystemOpenMode,
  ): void => {
    const canonicalSource = canonicalFilesystemModuleSpecifier(source);
    if (canonicalSource === undefined) return;
    if (member.includes(".")) {
      if (!member.startsWith("constants.")) addUnmodeledFilesystem(canonicalSource, `dotted-api-${member}`);
      return;
    }
    const classification = classifyFilesystemApi(member, openMode);
    addFact(canonicalSource, classification.effects);
    if (!classification.modeled) unmodeled.add(`${canonicalSource}:api-${member}`);
  };

  for (const source of dynamicFilesystemSources) {
    addFact(canonicalFilesystemModuleSpecifier(source)!, ["filesystem-read", "filesystem-write"]);
  }

  for (const [name, binding] of state.bindings) {
    if (binding.source === undefined || !isFilesystemModuleSpecifier(binding.source)) continue;
    const carrierReason = state.carrierReasons.get(name);
    if (carrierReason !== undefined) addUnmodeledFilesystem(binding.source, carrierReason);
    if (binding.kind === "member" && binding.member !== undefined &&
      binding.member !== "open" && binding.member !== "openSync") {
      classifyFilesystemMember(binding.source, binding.member);
    }
  }

  for (const call of calls) {
    const callee = unwrapArchitectureExpression(astNode(call.callee));
    if (!callee) continue;
    const acquiredSource = moduleAcquisitionSpecifier(call, state);
    const loaderCarrierReason = moduleCarrierReason(callee, state);
    if (loaderCarrierReason !== undefined && acquiredSource !== undefined &&
      isFilesystemModuleSpecifier(acquiredSource)) {
      addUnmodeledFilesystem(acquiredSource, `loader-${loaderCarrierReason}`);
    }
    for (const argument of astNodeArray(call.arguments)) {
      const argumentValue = resolveModuleValue(argument, state);
      if (argumentValue?.kind === "namespace" && argumentValue.source !== undefined &&
        isFilesystemModuleSpecifier(argumentValue.source)) {
        addUnmodeledFilesystem(argumentValue.source, "namespace-escape");
      }
    }
    const calleeValue = resolveModuleValue(callee, state);
    if (calleeValue?.source !== undefined && isFilesystemModuleSpecifier(calleeValue.source)) {
      if (calleeValue.kind === "member" && calleeValue.member !== undefined) {
        const member = calleeValue.member;
        const openMode = member === "open" || member === "openSync"
          ? filesystemOpenMode(astNodeArray(call.arguments)[1], state)
          : undefined;
        classifyFilesystemMember(calleeValue.source, member, openMode);
      } else if (calleeValue.kind === "namespace") {
        addUnmodeledFilesystem(calleeValue.source, "namespace-call");
      }
    }
    if (calleeValue?.kind === "member" &&
      (calleeValue.source === "child_process" || calleeValue.source === "node:child_process") &&
      calleeValue.member !== undefined && isRuntimeExecutionApi(calleeValue.member)) {
      const classification = classifyChildInvocation(sourcePath, calleeValue.member, call, state);
      if (classification === "git") {
        addFact("git-invocation", ["git"]);
      } else if (classification === "unmodeled") {
        addFact("git-invocation", ["git"]);
        unmodeled.add(`node:child_process:dynamic-executable-${calleeValue.member}`);
      }
    }
  }

  for (const memberNode of members) {
    const value = resolveModuleValue(memberNode, state);
    if (value?.kind === "member" && value.source !== undefined && value.member !== undefined &&
      isFilesystemModuleSpecifier(value.source) && value.member !== "open" && value.member !== "openSync") {
      classifyFilesystemMember(value.source, value.member);
    }
    const property = architecturePropertyName(memberNode, state);
    if (property !== undefined) continue;
    const object = astNode(memberNode.object);
    const objectValue = object ? resolveModuleValue(object, state) : undefined;
    if (objectValue?.kind === "namespace" && objectValue.source !== undefined &&
      isFilesystemModuleSpecifier(objectValue.source)) {
      addUnmodeledFilesystem(objectValue.source, "dynamic-member");
    }
  }

  const facts = [...effectFacts.entries()].map(([ownerLabel, effects]): DirectEffectFact => ({
    ownerLabel,
    effects: [...effects].toSorted(),
  })).toSorted((left, right) => left.ownerLabel.localeCompare(right.ownerLabel));
  return { facts, unmodeled: [...unmodeled].toSorted() };
}

function moduleCarrierReason(expression: AstNode, state: ModuleBindingState): string | undefined {
  let current = unwrapArchitectureExpression(expression);
  while (current && (current.type === "MemberExpression" || current.type === "OptionalMemberExpression")) {
    current = unwrapArchitectureExpression(astNode(current.object));
  }
  return current?.type === "Identifier" ? state.carrierReasons.get(String(current.name)) : undefined;
}

function classifyChildInvocation(
  sourcePath: string,
  api: string,
  call: AstNode,
  state: ModuleBindingState,
): "git" | "modeled-non-git" | "unmodeled" {
  if (api === "fork") return "modeled-non-git";
  const argumentsList = astNodeArray(call.arguments);
  const executable = argumentsList[0];
  if (!executable) return "unmodeled";
  if (sourcePath === "src/process/pinned-process-internal.ts" &&
    staticMemberPath(executable) === "profile.executablePath") return "modeled-non-git";
  if (isCentralPolicyGitExecutable(executable, state)) return "git";
  if (isCentralPolicyCommandEffectPythonExecutable(executable, state)) return "modeled-non-git";
  if (isCurrentNodeExecutable(executable, state)) return "modeled-non-git";
  const value = resolveStaticArchitectureString(executable, state);
  if (value === undefined) return "unmodeled";
  if (api === "exec" || api === "execSync") {
    return classifyShellCommand(value);
  }
  const childArguments = argumentsList[1]
    ? resolveStaticArchitectureStringArray(argumentsList[1]!, state)
    : [];
  if (childArguments === undefined) {
    return isGitExecutable(value) ? "git" : "unmodeled";
  }
  return classifyProcessInvocation(value, childArguments);
}

function isCurrentNodeExecutable(expression: AstNode, state: ModuleBindingState): boolean {
  if (moduleCarrierReason(expression, state) !== undefined) return false;
  const value = resolveModuleValue(expression, state);
  return value?.kind === "member" && value.source === "node:process" && value.member === "execPath";
}

function isCentralPolicyGitExecutable(expression: AstNode, state: ModuleBindingState): boolean {
  return isCentralRootPolicyMember(
    expression,
    state,
    "verification.candidateFormat.gitIdentity.executablePath",
  );
}

function isCentralPolicyCommandEffectPythonExecutable(expression: AstNode, state: ModuleBindingState): boolean {
  return isCentralRootPolicyMember(
    expression,
    state,
    "verification.commandEffectInventory.pythonExecutable",
  );
}

function isCentralPolicyLinuxPathOnlyOpenFlag(
  expression: AstNode,
  state: ModuleBindingState,
): boolean {
  return isCentralRootPolicyMember(
    expression,
    state,
    "receipts.immutableExecution.linuxPathOnlyOpenFlag",
  );
}

function isCentralRootPolicyMember(
  expression: AstNode,
  state: ModuleBindingState,
  expectedPath: string,
): boolean {
  const properties: string[] = [];
  let current = unwrapArchitectureExpression(expression);
  while (current && (current.type === "MemberExpression" || current.type === "OptionalMemberExpression")) {
    const property = architecturePropertyName(current, state);
    if (property === undefined) return false;
    properties.push(property);
    current = unwrapArchitectureExpression(astNode(current.object));
  }
  if (current?.type !== "Identifier" || properties.reverse().join(".") !== expectedPath) {
    return false;
  }
  const binding = state.bindings.get(String(current.name));
  return binding?.kind === "member" && binding.source === "src/kernel/root-policy.ts" && binding.member === "ROOT_POLICY";
}

function filesystemOpenMode(flags: AstNode | undefined, state: ModuleBindingState): FilesystemOpenMode {
  if (!flags) return "unknown";
  const tokens = filesystemOpenFlagTokens(flags, state);
  return tokens === undefined ? "unknown" : classifyFilesystemOpenFlagTokens(tokens);
}

function filesystemOpenFlagTokens(
  input: AstNode,
  state: ModuleBindingState,
  active = new Set<AstNode>(),
): readonly (number | string)[] | undefined {
  const node = unwrapArchitectureExpression(input);
  if (!node || active.has(node)) return undefined;
  active.add(node);
  try {
    if (node.type === "StringLiteral") return [String(node.value)];
    if (node.type === "NumericLiteral") return [Number(node.value)];
    if (node.type === "Identifier") {
      const initializer = state.constantInitializers.get(String(node.name));
      return initializer ? filesystemOpenFlagTokens(initializer, state, active) : undefined;
    }
    if (node.type === "BinaryExpression" && node.operator === "|") {
      const left = astNode(node.left);
      const right = astNode(node.right);
      const leftTokens = left ? filesystemOpenFlagTokens(left, state, active) : undefined;
      const rightTokens = right ? filesystemOpenFlagTokens(right, state, active) : undefined;
      return leftTokens && rightTokens ? [...leftTokens, ...rightTokens] : undefined;
    }
    if (node.type === "ConditionalExpression") {
      const consequent = astNode(node.consequent);
      const alternate = astNode(node.alternate);
      const consequentTokens = consequent ? filesystemOpenFlagTokens(consequent, state, active) : undefined;
      const alternateTokens = alternate ? filesystemOpenFlagTokens(alternate, state, active) : undefined;
      return consequentTokens && alternateTokens ? [...consequentTokens, ...alternateTokens] : undefined;
    }
    if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
      if (isCentralPolicyLinuxPathOnlyOpenFlag(node, state)) return [0, "O_PATH"];
      const value = resolveModuleValue(node, state);
      const member = value?.member?.split(".").at(-1);
      return member?.startsWith("O_") ? [member] : undefined;
    }
    const staticValue = resolveStaticArchitectureString(node, state);
    return staticValue === undefined ? undefined : [staticValue];
  } finally {
    active.delete(node);
  }
}

function architecturePropertyName(node: AstNode, state: ModuleBindingState): string | undefined {
  const property = astNode(node.property ?? node.key);
  if (!property) return undefined;
  if (node.computed !== true && property.type === "Identifier") return String(property.name);
  if (node.computed !== true && property.type === "StringLiteral") return String(property.value);
  return resolveStaticArchitectureString(property, state);
}

function resolveStaticArchitectureString(
  input: AstNode,
  state: ModuleBindingState,
  active = new Set<AstNode>(),
): string | undefined {
  const node = unwrapArchitectureExpression(input);
  if (!node || active.has(node)) return undefined;
  active.add(node);
  try {
    if (node.type === "StringLiteral") return String(node.value);
    if (node.type === "Identifier") {
      if (state.mutatedNames.has(String(node.name))) return undefined;
      const initializer = state.constantInitializers.get(String(node.name));
      return initializer ? resolveStaticArchitectureString(initializer, state, active) : undefined;
    }
    if (node.type === "BinaryExpression" && node.operator === "+") {
      const left = astNode(node.left);
      const right = astNode(node.right);
      if (!left || !right) return undefined;
      const leftValue = resolveStaticArchitectureString(left, state, active);
      const rightValue = resolveStaticArchitectureString(right, state, active);
      return leftValue === undefined || rightValue === undefined ? undefined : leftValue + rightValue;
    }
    if (node.type === "TemplateLiteral") {
      const quasis = astNodeArray(node.quasis);
      const expressions = astNodeArray(node.expressions);
      let output = "";
      for (let index = 0; index < quasis.length; index += 1) {
        const value = astRecord(quasis[index]!.value);
        if (typeof value?.cooked !== "string") return undefined;
        output += value.cooked;
        const substitution = expressions[index];
        if (substitution) {
          const result = resolveStaticArchitectureString(substitution, state, active);
          if (result === undefined) return undefined;
          output += result;
        }
      }
      return output;
    }
    return undefined;
  } finally {
    active.delete(node);
  }
}

function resolveStaticArchitectureStringArray(
  input: AstNode,
  state: ModuleBindingState,
  active = new Set<AstNode>(),
): readonly string[] | undefined {
  const node = unwrapArchitectureExpression(input);
  if (!node || active.has(node)) return undefined;
  active.add(node);
  try {
    if (node.type === "Identifier") {
      if (state.mutatedNames.has(String(node.name))) return undefined;
      const initializer = state.constantInitializers.get(String(node.name));
      return initializer ? resolveStaticArchitectureStringArray(initializer, state, active) : undefined;
    }
    if (node.type !== "ArrayExpression" || !Array.isArray(node.elements)) return undefined;
    const output: string[] = [];
    for (const rawElement of node.elements) {
      const element = astNode(rawElement);
      if (!element) return undefined;
      if (element.type === "SpreadElement") {
        const argument = astNode(element.argument);
        const spread = argument ? resolveStaticArchitectureStringArray(argument, state, active) : undefined;
        if (spread === undefined) return undefined;
        output.push(...spread);
        continue;
      }
      const value = resolveStaticArchitectureString(element, state);
      if (value === undefined) return undefined;
      output.push(value);
    }
    return output;
  } finally {
    active.delete(node);
  }
}

function unwrapArchitectureExpression(node: AstNode | undefined): AstNode | undefined {
  let current = node;
  while (current && [
    "AwaitExpression", "ParenthesizedExpression", "TSAsExpression", "TSInstantiationExpression",
    "TSNonNullExpression", "TSSatisfiesExpression", "TSTypeAssertion", "TypeCastExpression",
  ].includes(current.type)) {
    current = astNode(current.argument ?? current.expression);
  }
  return current;
}

function collectMutatedArchitectureNames(root: AstNode): ReadonlySet<string> {
  const names = new Set<string>();
  const pending = [root];
  const visited = new Set<AstNode>();
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);
    if (node.type === "AssignmentExpression" || node.type === "UpdateExpression") {
      const target = unwrapArchitectureExpression(astNode(node.left) ?? astNode(node.argument));
      if (target && (target.type === "MemberExpression" || target.type === "OptionalMemberExpression")) {
        continue;
      }
      for (const name of bindingNames(target)) names.add(name);
    }
    pending.push(...astChildren(node));
  }
  return names;
}

export function verifyArchitectureSources(
  sources: readonly ArchitectureSource[],
  manifest: ArchitectureManifest = ARCHITECTURE_MANIFEST,
  externalCommandSources?: readonly ArchitectureSource[],
): ArchitectureVerification {
  const violations: string[] = [];
  const sourceByPath = uniqueMap(sources, (entry) => entry.path, "architecture-source-duplicate", violations);
  const moduleByPath = uniqueMap(manifest.modules, (entry) => entry.path, "architecture-module-path-duplicate", violations);
  uniqueMap(manifest.modules, (entry) => entry.id, "architecture-module-id-duplicate", violations);
  const expectedPaths = [...moduleByPath.keys()].toSorted();
  const actualPaths = [...sourceByPath.keys()].toSorted();
  if (!sameOrderedValues(expectedPaths, actualPaths)) violations.push("architecture-module-registration-drift");
  verifyCompositionRoots(manifest, moduleByPath, violations);
  verifyExternalCommands(manifest, moduleByPath, violations, externalCommandSources);
  verifyOwnedIdentifiers(manifest.modules, violations);
  verifyArchitectureFindings(manifest, violations);

  const graph = new Map<string, readonly string[]>();
  for (const module of manifest.modules) {
    const source = sourceByPath.get(module.path);
    if (!source) continue;
    if (Buffer.byteLength(source.source, "utf8") > manifest.analysisLimits.maximumSourceBytes) {
      violations.push(`architecture-source-too-large:${module.path}`);
      continue;
    }
    let facts: ArchitectureSourceFacts;
    try {
      facts = analyzeArchitectureSource(module.path, source.source);
    } catch {
      violations.push(`architecture-source-parse:${module.path}`);
      continue;
    }
    if (facts.nodeCount > manifest.analysisLimits.maximumAstNodes) {
      violations.push(`architecture-source-node-limit:${module.path}`);
      continue;
    }
    const lexical = analyzeStaticModuleShape(source.source, module.path);
    const lexicalDependencies = lexical.analysis.moduleAcquisitions
      .map((entry) => entry.specifier === null ? null : resolveSpecifier(module.path, entry.specifier));
    if (lexical.analysis.unmodeledModuleAcquisition || lexicalDependencies.includes(null)) {
      violations.push(`architecture-lexical-module-unmodeled:${module.path}`);
    } else if (!sameOrderedValues(facts.dependencies, [...new Set(lexicalDependencies as string[])].toSorted())) {
      violations.push(`architecture-independent-import-disagreement:${module.path}`);
    }
    const lexicalTypeReferences = [...new Set(lexical.analysis.typeOnlyModuleReferences
      .map((specifier) => resolveSpecifier(module.path, specifier)))].toSorted();
    if (!sameOrderedValues(facts.typeOnlyDependencies, lexicalTypeReferences)) {
      violations.push(`architecture-independent-type-reference-disagreement:${module.path}`);
    }
    if (!sameOrderedValues(facts.exportedNames, lexical.exportedNames)) {
      violations.push(`architecture-independent-export-disagreement:${module.path}`);
    }
    if (!sameOrderedValues(facts.dependencies, [...module.dependencies].toSorted())) {
      violations.push(`architecture-dependency-drift:${module.path}`);
    }
    if (facts.exportedNames.length !== module.publicApi.exportCount ||
      canonicalHash(facts.exportedNames) !== module.publicApi.namesSha256) {
      violations.push(`architecture-public-api-drift:${module.path}`);
    }
    const internalDependencies = facts.dependencies.filter((dependency) => moduleByPath.has(dependency));
    graph.set(module.path, internalDependencies);
    verifyDependencyUniverse(
      module,
      [...facts.dependencies, ...facts.typeOnlyDependencies],
      moduleByPath,
      manifest,
      violations,
    );
    verifyModuleEdges(module, internalDependencies, moduleByPath, violations);
    verifyEffects(module, facts, violations);
    verifyInternalImportBoundaries(module, facts, violations);
    verifyDeclarations(module, facts, manifest.modules, violations);
    if (facts.directExecutionEntrypoint && !module.compositionRoot) {
      violations.push(`architecture-unregistered-command-root:${module.path}`);
    }
  }
  verifyCycles(graph, violations);
  const graphHash = canonicalHash([...graph.entries()].map(([path, dependencies]) => ({ path, dependencies })));
  return deepFreeze({ ok: violations.length === 0, graphHash, violations: [...new Set(violations)].toSorted() });
}

function verifyInternalImportBoundaries(
  module: ArchitectureModule,
  facts: ArchitectureSourceFacts,
  violations: string[],
): void {
  for (const policy of INTERNAL_IMPORT_POLICIES) {
    const internalImports = facts.importedSymbols.filter((entry) => entry.source === policy.path);
    if (internalImports.length === 0) continue;
    if (!policy.allowedImporters.some((path) => path === module.path)) {
      violations.push(`architecture-${policy.id}-internal-import-denied:${module.path}`);
      continue;
    }
    if (internalImports.some((entry) =>
      policy.deniedNames.some((deniedName) => deniedName === entry.importedName)
    )) {
      violations.push(`architecture-${policy.id}-mechanism-test-import-denied:${module.path}`);
    }
  }
}

function verifyExternalCommands(
  manifest: ArchitectureManifest,
  modules: ReadonlyMap<string, ArchitectureModule>,
  violations: string[],
  externalCommandSources?: readonly ArchitectureSource[],
): void {
  const paths = manifest.externalCommands.map((command) => command.path);
  if (!sameOrderedValues(paths, [...paths].toSorted()) || new Set(paths).size !== paths.length) {
    violations.push("architecture-external-command-list-invalid");
  }
  const ids = new Set<string>();
  const sourceByPath = new Map<string, string>();
  if (externalCommandSources !== undefined) {
    for (const entry of externalCommandSources) sourceByPath.set(entry.path, entry.source);
  }
  const verifyContent = externalCommandSources !== undefined;
  for (const command of manifest.externalCommands) {
    if (ids.has(command.id)) violations.push(`architecture-external-command-id-duplicate:${command.id}`);
    ids.add(command.id);
    if (command.id.trim().length === 0 || command.owner.trim().length === 0 ||
      !command.path.startsWith("verification/") ||
      (command.language === "python" ? !command.path.endsWith(".py") : !command.path.endsWith(".sh")) ||
      (command.language === "shell" && command.exposure !== "research-only-non-model-facing") ||
      !/^[a-f0-9]{64}$/u.test(command.sourceSha256)) {
      violations.push(`architecture-external-command-invalid:${command.path}`);
    }
    if (modules.has(command.path)) violations.push(`architecture-external-command-module-conflict:${command.path}`);
    if (!sameOrderedValues(command.effects, [...new Set(command.effects)].toSorted())) {
      violations.push(`architecture-external-command-effects-invalid:${command.path}`);
    }
    if (verifyContent) {
      const source = sourceByPath.get(command.path);
      if (source === undefined) {
        violations.push(`architecture-external-command-source-missing:${command.path}`);
      } else if (sha256(source) !== command.sourceSha256) {
        violations.push(`architecture-external-command-source-hash-drift:${command.path}`);
      }
    }
  }
}

/**
 * The census of what the repository SCANS and the census of what a module
 * IMPORTS are judged against each other here, because they were previously
 * derived independently and could therefore disagree in silence.
 *
 * `internalDependencies` above keeps only the dependencies that are registered
 * modules — which is correct for edge and cycle analysis and fatal on its own:
 * every dependency the manifest does not know about was DISCARDED, so an
 * import that crossed into a directory the scan refuses to walk produced no
 * edge, no violation, and no trace. That is how a production barrel came to
 * re-export a value from `_experiments/` — a directory `repositoryScanExclusions`
 * prunes from every scan — with the edge recorded in the manifest and every
 * guard whose universe came from those exclusions short by exactly that
 * dependency. The dependency was not unverified; it was invisible.
 *
 * So each discarded dependency must be explained by ONE of two answers, both
 * derived from the same owners the scanners use:
 *
 * - the scan itself refuses this path (`repositoryScanExclusionFor`, over
 *   `repositoryScanExclusions` + `experimentSourceExclusions`) — then
 *   importing it is a contradiction, not an exemption. We do not get to say
 *   "this directory is not part of the codebase" and depend on it;
 * - the path lies under a declared source root but is not a registered module
 *   — then the manifest is incomplete, and every verdict computed from it is
 *   short by that module.
 *
 * Anything else is an external specifier (`node:fs`, `@babel/parser`, an
 * absolute path into a benchmark sandbox) and is not this function's subject.
 * Absolute specifiers are skipped explicitly: they are not repository paths,
 * so a `node_modules` segment inside one says nothing about our scan universe.
 */
function verifyDependencyUniverse(
  module: ArchitectureModule,
  dependencies: readonly string[],
  moduleByPath: ReadonlyMap<string, ArchitectureModule>,
  manifest: ArchitectureManifest,
  violations: string[],
): void {
  for (const dependency of dependencies) {
    if (moduleByPath.has(dependency)) continue;
    if (dependency.startsWith("/")) continue;
    const exclusion = repositoryScanExclusionFor(dependency);
    if (exclusion !== undefined) {
      violations.push(
        `architecture-scan-excluded-dependency:${module.path}->${dependency}:${exclusion.reason}:${exclusion.segment}`,
      );
      continue;
    }
    if (manifest.sourceRoots.some((root) => dependency.startsWith(root))) {
      violations.push(`architecture-unregistered-dependency:${module.path}->${dependency}`);
    }
  }
}

function verifyModuleEdges(
  module: ArchitectureModule,
  dependencies: readonly string[],
  moduleByPath: ReadonlyMap<string, ArchitectureModule>,
  violations: string[],
): void {
  for (const dependency of dependencies) {
    const target = moduleByPath.get(dependency)!;
    if (!module.allowedDependencyLayers.includes(target.layer)) {
      violations.push(`architecture-reverse-layer:${module.path}->${dependency}`);
    }
    if ((module.realm === "runtime" || module.realm === "shared") && target.realm === "builder") {
      violations.push(`architecture-realm-direction:${module.path}->${dependency}`);
    }
  }
}

function verifyEffects(
  module: ArchitectureModule,
  facts: ArchitectureSourceFacts,
  violations: string[],
): void {
  const inferredEffects = new Set<ArchitectureEffect>();
  for (const dependency of facts.dependencies) {
    const required = dependencyEffects(dependency);
    for (const effect of required) inferredEffects.add(effect);
    const missing = required.filter((effect) => !module.effects.includes(effect));
    if (missing.length > 0) {
      violations.push(`architecture-effect-owner:${module.path}:${dependency}:${missing.join(",")}`);
    }
  }
  for (const fact of facts.directEffectFacts) {
    for (const effect of fact.effects) inferredEffects.add(effect);
    const missing = fact.effects.filter((effect) => !module.effects.includes(effect));
    if (missing.length > 0) {
      violations.push(`architecture-effect-owner:${module.path}:${fact.ownerLabel}:${missing.join(",")}`);
    }
  }
  for (const reason of facts.unmodeledEffects) {
    violations.push(`architecture-effect-unmodeled:${module.path}:${reason}`);
  }
  const allowed = new Set(ALLOWED_BOUNDARY_EFFECTS[module.executionBoundary]);
  const disallowed = [...new Set([...module.effects, ...inferredEffects])]
    .filter((effect) => !allowed.has(effect)).toSorted();
  if (disallowed.length > 0) {
    violations.push(`architecture-effect-boundary:${module.path}:${module.executionBoundary}:${disallowed.join(",")}`);
  }
}

function verifyDeclarations(
  module: ArchitectureModule,
  facts: ArchitectureSourceFacts,
  modules: readonly ArchitectureModule[],
  violations: string[],
): void {
  const authorityOwners = new Map<string, string>();
  for (const candidate of modules) {
    for (const identifier of candidate.authorityIdentifiers) authorityOwners.set(identifier, candidate.path);
  }
  for (const declaration of facts.declaredNames) {
    const exactOwner = authorityOwners.get(declaration.name);
    if (exactOwner && exactOwner !== module.path) {
      violations.push(`architecture-duplicate-authority:${module.path}:${declaration.name}`);
    }
    const family = authorityFamily(declaration);
    if (family && !module.authorityFamilies.includes(family)) {
      violations.push(`architecture-local-${family}-authority:${module.path}:${declaration.name}`);
    }
  }
  if (!module.compositionRoot && facts.constructedTypes.some((name) => /(?:Adapter|Client|Gateway|Store)$/u.test(name))) {
    violations.push(`architecture-adapter-construction:${module.path}`);
  }
}

function authorityFamily(declaration: DeclaredName): ArchitectureAuthorityFamily | undefined {
  const normalized = declaration.name.replaceAll(/[^a-z0-9]/giu, "").toLocaleLowerCase("en-US");
  if (declaration.extendsGlobalError || /(?:errorregistry|errortaxonomy)$/u.test(normalized)) return "errors";
  if (/(?:configauthority|configregistry|configurationauthority|configurationregistry|configdocumentschema)$/u
    .test(normalized)) return "configuration";
  if (/(?:eventregistry|eventschema|eventtaxonomy)$/u.test(normalized)) return "events";
  if (/(?:classificationcatalog|classificationregistry|classificationtaxonomy|dataclassification)$/u
    .test(normalized)) return "data-classification";
  return undefined;
}

function verifyOwnedIdentifiers(modules: readonly ArchitectureModule[], violations: string[]): void {
  const owners = new Map<string, string>();
  for (const module of modules) {
    for (const [kind, identifiers] of [
      ["authority", module.authorityIdentifiers], ["config", module.configPaths],
      ["port", module.ports.provides], ["projection", module.projectionOwners], ["state", module.stateOwners],
      ["responsibility", module.responsibilities],
    ] as const) {
      for (const identifier of identifiers) {
        const key = `${kind}:${identifier}`;
        const previous = owners.get(key);
        if (previous) violations.push(`architecture-owner-duplicate:${key}:${previous}:${module.path}`);
        else owners.set(key, module.path);
      }
    }
  }
}

function verifyArchitectureFindings(
  manifest: ArchitectureManifest,
  violations: string[],
): void {
  const findingIds = new Set<string>();
  for (const finding of manifest.findings) {
    if (findingIds.has(finding.id)) violations.push(`architecture-finding-duplicate:${finding.id}`);
    findingIds.add(finding.id);
    const requiredText = [
      finding.id,
      finding.owner,
      finding.rationale,
      finding.removalCondition,
      finding.deadline,
      finding.regression,
      finding.removalVerification,
    ];
    if (requiredText.some((value) => value.trim().length === 0 || /^(?:n\/?a|none|unknown)$/iu.test(value.trim())) ||
      finding.evidenceLinks.length === 0 || finding.affectedSurfaces.length === 0 ||
      finding.blockedCapabilities.length === 0) {
      violations.push(`architecture-finding-incomplete:${finding.id}`);
    }
    if (finding.status === "open-blocking") {
      violations.push(`architecture-open-blocking-finding:${finding.id}`);
    }
  }
  const hasOpenFinding = manifest.findings.some((finding) => finding.status === "open-blocking");
  if (hasOpenFinding !== manifest.physicalLayoutStatus.startsWith("open-blocking")) {
    violations.push("architecture-physical-layout-status-drift");
  }
}

function verifyCompositionRoots(
  manifest: ArchitectureManifest,
  modules: ReadonlyMap<string, ArchitectureModule>,
  violations: string[],
): void {
  const expected: string[] = [];
  const rootRealms = new Map<string, ArchitectureRealm>();
  for (const realm of ["builder", "runtime", "shared"] as const) {
    const roots = manifest.compositionRoots[realm];
    if (!sameOrderedValues(roots, [...roots].toSorted()) || new Set(roots).size !== roots.length) {
      violations.push(`architecture-composition-root-list-invalid:${realm}`);
    }
    for (const path of roots) {
      expected.push(path);
      const previousRealm = rootRealms.get(path);
      if (previousRealm !== undefined) {
        violations.push(`architecture-composition-root-duplicate:${path}:${previousRealm}:${realm}`);
        continue;
      }
      rootRealms.set(path, realm);
      const module = modules.get(path);
      if (!module) {
        violations.push(`architecture-composition-root-missing:${realm}:${path}`);
      } else if (module.realm !== realm) {
        violations.push(`architecture-composition-root-realm:${path}:${realm}:${module.realm}`);
      }
    }
  }
  for (const module of manifest.modules) {
    if (module.compositionRoot !== (module.executionBoundary === "composition-root")) {
      violations.push(`architecture-composition-root-boundary:${module.path}`);
    }
  }
  const normalizedExpected = [...new Set(expected)].toSorted();
  const actual = manifest.modules.filter((module) => module.compositionRoot).map((module) => module.path).toSorted();
  if (!sameOrderedValues(normalizedExpected, actual) || normalizedExpected.some((path) => !modules.has(path))) {
    violations.push("architecture-composition-root-drift");
  }
}

function verifyCycles(graph: ReadonlyMap<string, readonly string[]>, violations: string[]): void {
  const complete = new Set<string>();
  const active = new Set<string>();
  function visit(path: string): void {
    if (complete.has(path)) return;
    if (active.has(path)) {
      violations.push(`architecture-import-cycle:${path}`);
      return;
    }
    active.add(path);
    for (const dependency of graph.get(path) ?? []) visit(dependency);
    active.delete(path);
    complete.add(path);
  }
  for (const path of graph.keys()) visit(path);
}

function declaredAstName(node: AstNode): DeclaredName | undefined {
  if (node.type === "VariableDeclarator") {
    const identifier = astNode(node.id);
    return identifier?.type === "Identifier"
      ? { name: String(identifier.name), kind: node.type, extendsGlobalError: false }
      : undefined;
  }
  if (!["ClassDeclaration", "FunctionDeclaration", "TSInterfaceDeclaration", "TSTypeAliasDeclaration"]
    .includes(node.type)) return undefined;
  const identifier = astNode(node.id);
  if (identifier?.type !== "Identifier") return undefined;
  const superclass = astNode(node.superClass);
  return {
    name: String(identifier.name),
    kind: node.type,
    extendsGlobalError: node.type === "ClassDeclaration" && superclass?.type === "Identifier" &&
      superclass.name === "Error",
  };
}

function declarationExportNames(declaration: AstNode | undefined): readonly string[] {
  if (!declaration) return [];
  const identifier = astNode(declaration.id);
  if (identifier?.type === "Identifier") return [String(identifier.name)];
  if (declaration.type !== "VariableDeclaration") return [];
  return astNodeArray(declaration.declarations).flatMap((entry) => bindingNames(astNode(entry.id)));
}

function bindingNames(node: AstNode | undefined): readonly string[] {
  if (!node) return [];
  if (node.type === "Identifier") return [String(node.name)];
  return astChildren(node).flatMap((child) => bindingNames(child));
}

function staticCalleeName(node: AstNode | undefined): string | undefined {
  if (node?.type === "Identifier") return String(node.name);
  if (node?.type !== "MemberExpression" && node?.type !== "OptionalMemberExpression") return undefined;
  const property = astNode(node.property);
  return node.computed !== true && property?.type === "Identifier" ? String(property.name) :
    property?.type === "StringLiteral" ? String(property.value) : undefined;
}

function astContainsStaticMember(node: AstNode, expected: string): boolean {
  const pending = [node];
  const visited = new Set<AstNode>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    if (staticMemberPath(current) === expected) return true;
    pending.push(...astChildren(current));
  }
  return false;
}

function staticMemberPath(node: AstNode | undefined): string | undefined {
  if (node?.type === "Identifier") return String(node.name);
  if (node?.type === "MetaProperty") {
    const meta = astNode(node.meta);
    const property = astNode(node.property);
    return meta?.type === "Identifier" && property?.type === "Identifier"
      ? `${String(meta.name)}.${String(property.name)}`
      : undefined;
  }
  if (node?.type !== "MemberExpression" && node?.type !== "OptionalMemberExpression") return undefined;
  const objectPath = staticMemberPath(astNode(node.object));
  const property = astNode(node.property);
  const propertyName = node.computed !== true && property?.type === "Identifier"
    ? String(property.name)
    : property?.type === "StringLiteral" ? String(property.value) : undefined;
  return objectPath && propertyName ? `${objectPath}.${propertyName}` : undefined;
}

function resolveSpecifier(path: string, specifier: string): string {
  return specifier.startsWith(".") ? posix.normalize(posix.join(posix.dirname(path), specifier)) : specifier;
}

function astRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function uniqueMap<T>(
  entries: readonly T[],
  key: (entry: T) => string,
  code: string,
  violations: string[],
): Map<string, T> {
  const output = new Map<string, T>();
  for (const entry of entries) {
    const value = key(entry);
    if (output.has(value)) violations.push(`${code}:${value}`);
    else output.set(value, entry);
  }
  return output;
}
