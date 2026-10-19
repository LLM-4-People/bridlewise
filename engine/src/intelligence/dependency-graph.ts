import { deepFreeze } from "../kernel/integrity.ts";
import { getLanguageByExtension, type LanguageId } from "./language-registry.ts";
import { DEFAULT_HUB_NODE_MIN_IN_DEGREE, DEFAULT_INCLUDE_SEARCH_DEPTH } from "./intelligence-config.ts";
import type {
  DependencyEdge,
  DependencyGraph,
  RepositoryMap,
  CycleResult,
  ImpactResult,
} from "./intelligence-types.ts";

/**
 * Dependency graph builder and query engine.
 *
 * Builds a directed dependency graph from the repository map's import
 * statements. Each edge represents a module-level dependency (file A imports
 * from file B). The graph supports:
 *
 * - Forward dependencies: what does module X directly depend on?
 * - Reverse dependencies: what modules directly depend on X?
 * - Transitive closure: all modules reachable from X (forward or reverse)
 * - Cycle detection: all strongly-connected components with size > 1
 * - Impact analysis: what is affected if module X changes?
 *
 * Import specifiers are resolved to repository-relative file paths. The
 * resolver is MULTI-LANGUAGE (Task 1: code graph MAJOR REWRITE): JS/TS uses
 * Node ESM resolution (relative paths, extension inference, index files);
 * every other registered language uses language-specific resolution
 * (Python.py/__init__.py, Rust crate::/mod.rs, Go directory imports, Java
 * package→path, C/C++ #include, Ruby require_relative, etc.). Node builtins
 * (`node:*`) and bare package specifiers are excluded from the graph since
 * they are external to the repository.
 */

export function buildDependencyGraph(map: RepositoryMap): DependencyGraph {
  const edges: DependencyEdge[] = [];
  const filePathSet = new Set<string>();
  for (const mod of map.modules) {
    filePathSet.add(mod.path);
  }
  for (const mod of map.modules) {
    for (const imp of mod.imports) {
      if (imp.kind === "dynamic-import") continue;
      const resolved = resolveImport(mod.path, imp.specifier, filePathSet);
      if (resolved === null) continue;
      edges.push(Object.freeze({
        from: mod.path,
        to: resolved,
        specifier: imp.specifier,
      }));
    }
  }
  const forward = buildAdjacency(edges, true);
  const reverse = buildAdjacency(edges, false);
  return deepFreeze({
    edges: deepFreeze(edges),
    forwardAdjacency: forward,
    reverseAdjacency: reverse,
    nodeCount: filePathSet.size,
    edgeCount: edges.length,
  });
}

/**
 * Resolve an import specifier to a repository-relative file path. This is
 * the single dispatch point: it detects the importing file's language and
 * routes to the language-specific resolver. JS/TS uses the original Node ESM
 * heuristics (`resolveImportSpecifier`); every other language uses
 * `resolveImportForLanguage` (Task 1: multi-language support).
 */
function resolveImport(
  fromPath: string,
  specifier: string,
  knownPaths: ReadonlySet<string>,
): string | null {
  const spec = getLanguageByExtension(fromPath);
  // JS/TS: the original Node ESM resolver (handles.ts/.tsx/.js/.jsx/.mjs/.cjs/index)
  if (spec === undefined || spec.id === "javascript" || spec.id === "typescript") {
    return resolveImportSpecifier(fromPath, specifier, knownPaths);
  }
  return resolveImportForLanguage(spec.id, fromPath, specifier, knownPaths);
}

function buildAdjacency(
  edges: readonly DependencyEdge[],
  forward: boolean,
): ReadonlyMap<string, readonly string[]> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const from = forward ? edge.from : edge.to;
    const to = forward ? edge.to : edge.from;
    const list = adjacency.get(from);
    if (list === undefined) {
      adjacency.set(from, [to]);
    } else if (!list.includes(to)) {
      list.push(to);
    }
  }
  const result = new Map<string, readonly string[]>();
  for (const [key, value] of adjacency) {
    result.set(key, deepFreeze(value.toSorted()));
  }
  return result;
}

export function forwardDependencies(
  graph: DependencyGraph,
  filePath: string,
): readonly string[] {
  return graph.forwardAdjacency.get(filePath) ?? deepFreeze([]);
}

export function reverseDependencies(
  graph: DependencyGraph,
  filePath: string,
): readonly string[] {
  return graph.reverseAdjacency.get(filePath) ?? deepFreeze([]);
}

export function transitiveClosure(
  graph: DependencyGraph,
  filePath: string,
  direction: "forward" | "reverse",
): readonly string[] {
  const adjacency = direction === "forward" ? graph.forwardAdjacency : graph.reverseAdjacency;
  const visited = new Set<string>();
  const queue: string[] = [filePath];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const neighbors = adjacency.get(current) ?? [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) queue.push(neighbor);
    }
  }
  visited.delete(filePath);
  return deepFreeze([...visited].toSorted());
}

export function detectCycles(graph: DependencyGraph): CycleResult {
  const adjacency = graph.forwardAdjacency;
  const allNodes = new Set<string>();
  for (const [key, neighbors] of adjacency) {
    allNodes.add(key);
    for (const n of neighbors) allNodes.add(n);
  }
  const indexCounter = { value: 0 };
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const sccs: string[][] = [];

  function strongConnect(node: string): void {
    indices.set(node, indexCounter.value);
    lowLinks.set(node, indexCounter.value);
    indexCounter.value += 1;
    stack.push(node);
    onStack.add(node);
    const neighbors = adjacency.get(node) ?? [];
    for (const neighbor of neighbors) {
      if (!indices.has(neighbor)) {
        strongConnect(neighbor);
        const nl = lowLinks.get(neighbor)!;
        const cl = lowLinks.get(node)!;
        lowLinks.set(node, Math.min(cl, nl));
      } else if (onStack.has(neighbor)) {
        const ni = indices.get(neighbor)!;
        const cl = lowLinks.get(node)!;
        lowLinks.set(node, Math.min(cl, ni));
      }
    }
    if (lowLinks.get(node) === indices.get(node)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== node);
      sccs.push(scc);
    }
  }

  for (const node of allNodes) {
    if (!indices.has(node)) {
      strongConnect(node);
    }
  }
  const selfLoops = new Set<string>();
  for (const [node, neighbors] of adjacency) {
    if (neighbors.includes(node)) selfLoops.add(node);
  }
  const cycles = sccs
    .filter((scc) => scc.length > 1 || (scc.length === 1 && selfLoops.has(scc[0]!)))
    .map((scc) => deepFreeze(scc.toSorted()));
  return deepFreeze({
    hasCycles: cycles.length > 0,
    cycles: deepFreeze(cycles),
  });
}

export function impactAnalysis(
  graph: DependencyGraph,
  filePath: string,
): ImpactResult {
  const direct = reverseDependencies(graph, filePath);
  const transitive = transitiveClosure(graph, filePath, "reverse");
  return deepFreeze({
    directlyAffected: direct,
    transitivelyAffected: transitive,
    totalAffected: transitive.length,
  });
}

export function resolveImportSpecifier(
  fromPath: string,
  specifier: string,
  knownPaths: ReadonlySet<string>,
): string | null {
  if (specifier.startsWith("node:")) return null;
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return null;
  const fromDir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  const resolvedBase = specifier.startsWith("/")
    ? specifier.slice(1)
    : resolveRelative(fromDir, specifier);
  const candidates = [
    resolvedBase,
    `${resolvedBase}.ts`,
    `${resolvedBase}.tsx`,
    `${resolvedBase}.js`,
    `${resolvedBase}.jsx`,
    `${resolvedBase}.mjs`,
    `${resolvedBase}.cjs`,
    `${resolvedBase}/index.ts`,
    `${resolvedBase}/index.tsx`,
    `${resolvedBase}/index.js`,
    `${resolvedBase}/index.jsx`,
  ];
  for (const candidate of candidates) {
    if (knownPaths.has(candidate)) return candidate;
  }
  return null;
}

function resolveRelative(fromDir: string, specifier: string): string {
  const parts = specifier.split("/");
  const stack = fromDir.length > 0 ? fromDir.split("/") : [];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join("/");
}

/**
 * Multi-language import resolver (Task 1: code graph MAJOR REWRITE).
 *
 * Resolves a language-specific import specifier to a repository-relative
 * file path by checking candidate paths against the set of known source
 * files. Each language has its own resolution rules:
 *
 * - Python: `./foo` → `foo.py`, `foo/__init__.py` (relative to file dir)
 * - Rust: `crate::foo::bar` → `foo/bar.rs`, `foo/bar/mod.rs`, `foo.rs`
 * (crate root stripped; also tries `src/` prefix)
 * - Go: `./foo` → any `.go` file in the `foo` directory (directory import)
 * - Java/Kotlin/Scala: `com/foo/Bar` → `com/foo/Bar.java` (or `.kt`/`.scala`;
 * also tries `src/main/java/`, `src/` prefixes)
 * - C/C++: `foo.h` → `foo.h` relative to file dir + parent dirs
 * - Ruby: `./foo` → `foo.rb` relative to file dir
 * - PHP: `foo.php` → `foo.php` relative to file dir
 * - Dart: `./foo.dart` → relative to file dir
 * - C#: `Foo/Bar` → `Foo/Bar.cs` (also tries `src/` prefix)
 * - Zig: `foo.zig` → relative to file dir
 * - Lua: `foo.lua` → relative to file dir
 *
 * For "absolute" module paths (Java packages, Rust crate paths), the
 * resolver also does an ends-with match against knownPaths so it works
 * regardless of the project's source-root convention (src/, src/main/java/,
 * etc.).
 */
function resolveImportForLanguage(
  lang: LanguageId,
  fromPath: string,
  specifier: string,
  knownPaths: ReadonlySet<string>,
): string | null {
  if (specifier.length === 0) return null;
  const fromDir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";

  // Try a list of candidate paths; return the first that exists in knownPaths.
  const candidates = candidatesForLanguage(lang, fromDir, specifier);
  for (const c of candidates) {
    if (knownPaths.has(c)) return c;
  }
  // Ends-with fallback for absolute module paths (Java/Kotlin/Scala/Rust crate
  // paths whose source root is unknown). E.g. specifier `com/foo/Bar` with
  // extension `.java` → match any knownPath ending with `com/foo/Bar.java`.
  const exts = extensionsForLanguage(lang);
  for (const ext of exts) {
    const suffix = `${specifier}${ext}`;
    for (const known of knownPaths) {
      if (known === suffix || known.endsWith(`/${suffix}`)) return known;
    }
  }
  // Directory-match fallback: for languages where imports target a
  // DIRECTORY rather than a file (Go: `import "./pkg"` means the `pkg`
  // directory; any.go file inside is part of the package). Also catches
  // Python package imports (`from.pkg import x` → `./pkg` → `pkg/`). Match
  // any known file whose path starts with the resolved directory + "/".
  const resolvedDir = specifier.startsWith("/") || specifier.startsWith("./") || specifier.startsWith("../")
    ? resolveRelative(fromDir, specifier)
    : specifier.replace(/::/g, "/");
  for (const known of knownPaths) {
    if (known.startsWith(`${resolvedDir}/`)) return known;
  }
  return null;
}

/** File extensions to try for a language (for resolution candidates). */
function extensionsForLanguage(lang: LanguageId): readonly string[] {
  switch (lang) {
    case "python": return [".py", ".pyi"];
    case "rust": return [".rs"];
    case "go": return [".go"];
    case "java": return [".java"];
    case "c": return [".c", ".h"];
    case "cpp": return [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx", ".h"];
    case "c_sharp": return [".cs"];
    case "ruby": return [".rb"];
    case "php": return [".php"];
    case "swift": return [".swift"];
    case "kotlin": return [".kt", ".kts"];
    case "scala": return [".scala", ".sc"];
    case "lua": return [".lua"];
    case "dart": return [".dart"];
    case "zig": return [".zig"];
    case "bash": return [".sh", ".bash"];
    case "elixir": return [".ex", ".exs"];
    case "ocaml": return [".ml", ".mli"];
    case "elm": return [".elm"];
    case "rescript": return [".res", ".resi"];
    case "javascript": return [".js", ".jsx", ".mjs", ".cjs"];
    case "typescript": return [".ts", ".tsx", ".mts", ".cts"];
  }
}

/** Index file names per language (e.g. Python __init__.py, Rust mod.rs). */
function indexFilesForLanguage(lang: LanguageId): readonly string[] {
  switch (lang) {
    case "python": return ["__init__.py"];
    case "rust": return ["mod.rs", "lib.rs"];
    default: return [];
  }
}

/**
 * Generate candidate file paths for a language-specific import specifier.
 * Returns an ordered list of paths to check against knownPaths. Handles both
 * relative specifiers (./../) and absolute module paths (Java packages,
 * Rust crate paths) with common source-root conventions.
 */
function candidatesForLanguage(
  lang: LanguageId,
  fromDir: string,
  specifier: string,
): string[] {
  const exts = extensionsForLanguage(lang);
  const indices = indexFilesForLanguage(lang);
  const out: string[] = [];

  // Normalize the specifier into a path-like form.
  let base: string;
  let isRelative = false;

  if (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/")) {
    // Relative path (Python, Go, Ruby, PHP, Dart, C/C++, Zig, Lua, ReScript)
    isRelative = true;
    base = specifier.startsWith("/") ? specifier.slice(1) : resolveRelative(fromDir, specifier);
  } else if (lang === "rust" && (specifier.startsWith("crate::") || specifier.startsWith("super::") || specifier.startsWith("self::") || specifier.startsWith("crate_self::"))) {
    // Rust crate-relative: strip the prefix, replace:: with /
    base = specifier.replace(/^(?:crate|super|self|crate_self)::/, "").replace(/::/g, "/");
    // Also try with src/ prefix (Rust convention: crate root is src/)
    const srcBase = `src/${base}`;
    pushWithExts(out, srcBase, exts);
    pushWithIndices(out, srcBase, indices);
  } else if (lang === "go" && (specifier.startsWith("./") || specifier.startsWith("../"))) {
    // Go: imports are directories; the "module" is the directory. Resolve
    // to the directory path — the resolver will match any file inside via
    // the ends-with fallback. For direct candidate matching, try each.go
    // file... but we don't know the filenames. Just use the directory.
    base = resolveRelative(fromDir, specifier);
    out.push(base);
  } else if (lang === "c" || lang === "cpp") {
    // C/C++ #include: relative to file dir, or parent dirs (include paths)
    if (specifier.startsWith("/")) {
      base = specifier.slice(1);
    } else {
      base = resolveRelative(fromDir, specifier);
    }
    // Also try parent directories (common include path convention)
    out.push(specifier);
    pushWithExts(out, base, exts);
    // Try../prefix for up to DEFAULT_INCLUDE_SEARCH_DEPTH levels (common include path layout)
    let dir = fromDir;
    for (let i = 0; i < DEFAULT_INCLUDE_SEARCH_DEPTH && dir.length > 0; i++) {
      dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
      pushWithExts(out, dir.length > 0 ? `${dir}/${specifier}` : specifier, exts);
    }
    return dedupArray(out);
  } else if (lang === "java" || lang === "kotlin" || lang === "scala" || lang === "c_sharp") {
    // Java/Kotlin/Scala/C#: absolute package paths (com/foo/Bar)
    base = specifier.replace(/::/g, "/");
    // Try common source-root prefixes
    for (const prefix of ["", "src/main/java/", "src/main/kotlin/", "src/main/scala/", "src/"]) {
      pushWithExts(out, `${prefix}${base}`, exts);
    }
    return dedupArray(out);
  } else {
    // Default: treat as relative to file dir
    base = resolveRelative(fromDir, specifier);
  }

  // Standard candidate generation: base + extensions + index files
  pushWithExts(out, base, exts);
  for (const idx of indices) {
    out.push(`${base}/${idx}`);
  }

  // For relative specifiers, also try without the fromDir (in case the
  // specifier is already repo-relative)
  if (isRelative && fromDir.length > 0) {
    pushWithExts(out, specifier.replace(/^\.\//, ""), exts);
  }

  return dedupArray(out);
}

function pushWithExts(out: string[], base: string, exts: readonly string[]): void {
  // If the base already ends with one of the extensions, push it as-is
  for (const ext of exts) {
    if (base.endsWith(ext)) {
      out.push(base);
      return;
    }
  }
  // Otherwise push base + each extension
  for (const ext of exts) {
    out.push(`${base}${ext}`);
  }
}

function pushWithIndices(out: string[], base: string, indices: readonly string[]): void {
  for (const idx of indices) {
    out.push(`${base}/${idx}`);
  }
}

function dedupArray(arr: string[]): string[] {
  return [...new Set(arr)];
}

export function shortestPath(
  graph: DependencyGraph,
  from: string,
  to: string,
): readonly string[] | null {
  if (from === to) return deepFreeze([from]);
  const visited = new Set<string>([from]);
  const queue: Readonly<{ node: string; path: string[] }>[] = [{ node: from, path: [from] }];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const neighbors = graph.forwardAdjacency.get(current.node) ?? [];
    for (const neighbor of neighbors) {
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      const newPath = [...current.path, neighbor];
      if (neighbor === to) return deepFreeze(newPath);
      queue.push({ node: neighbor, path: newPath });
    }
  }
  return null;
}

export function graphStats(graph: DependencyGraph): Readonly<{
  maxInDegree: number;
  maxOutDegree: number;
  avgOutDegree: number;
  isolatedNodes: number;
  hubNodes: readonly Readonly<{ node: string; inDegree: number }>[];
}> {
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  for (const [node, neighbors] of graph.forwardAdjacency) {
    outDegree.set(node, neighbors.length);
    for (const n of neighbors) {
      inDegree.set(n, (inDegree.get(n) ?? 0) + 1);
    }
  }
  const allNodes = new Set<string>([
    ...graph.forwardAdjacency.keys(),
    ...graph.reverseAdjacency.keys(),
  ]);
  let maxIn = 0;
  let maxOut = 0;
  let totalOut = 0;
  let isolated = 0;
  const hubs: Readonly<{ node: string; inDegree: number }>[] = [];
  for (const node of allNodes) {
    const ind = inDegree.get(node) ?? 0;
    const outd = outDegree.get(node) ?? 0;
    maxIn = Math.max(maxIn, ind);
    maxOut = Math.max(maxOut, outd);
    totalOut += outd;
    if (ind === 0 && outd === 0) isolated += 1;
    if (ind >= DEFAULT_HUB_NODE_MIN_IN_DEGREE) hubs.push(Object.freeze({ node, inDegree: ind }));
  }
  return deepFreeze({
    maxInDegree: maxIn,
    maxOutDegree: maxOut,
    avgOutDegree: allNodes.size > 0 ? totalOut / allNodes.size : 0,
    isolatedNodes: isolated,
    hubNodes: deepFreeze(hubs.sort((a, b) => b.inDegree - a.inDegree)),
  });
}
