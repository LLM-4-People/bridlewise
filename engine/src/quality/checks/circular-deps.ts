/**
 * Circular-dependency check (EXP357).
 *
 * Builds an import graph and runs Tarjan SCC to find strongly-connected
 * components with ≥2 nodes. Language-agnostic: edges are `importer →
 * imported-module`. We resolve imports to file paths heuristically:
 * - Relative: resolve against the importer's directory.
 * - Bare (Python module `a.b`): map `a/b.py` or `a/__init__.py`.
 * - Bare (Rust `crate::a::b`): map `src/a/b.rs`.
 * - Bare (Go `import "a/b"`): map `b/<last-seg>.go` family.
 * - Bare (Java `import a.b.C`): map `a/b/C.java`.
 *
 * Missing resolution = no edge (we don't fabricate a target). The check
 * only reports confirmed cycles within the scanned file set.
 */

import type { Finding, ParsedFile, QualityConfig } from "../base.ts";

function resolveImportTarget(
  importer: string,
  source: string,
  isRelative: boolean,
  files: ReadonlySet<string>,
): string | null {
  if (isRelative) {
    const dir = importer.includes("/") ? importer.slice(0, importer.lastIndexOf("/")) : "";
    const joined = source.startsWith("/") ? source.slice(1) : (dir ? dir + "/" + source : source);
    // Try with extensions / index
    const candidates = [
      joined,
      joined + ".py",
      joined + ".rs",
      joined + ".go",
      joined + ".java",
      joined + ".ts",
      joined + ".tsx",
      joined + ".js",
      joined + "/index.ts",
      joined + "/index.js",
      joined + "/__init__.py",
      joined + "/mod.rs",
    ];
    for (const c of candidates) {
      if (files.has(c)) return c;
    }
    return null;
  }
  // Bare imports — try common path conventions.
  // Python: `a.b.c` → `a/b/c.py` or `a/b/c/__init__.py`
  const pyPath = source.replace(/\./g, "/");
  if (files.has(pyPath + ".py")) return pyPath + ".py";
  if (files.has(pyPath + "/__init__.py")) return pyPath + "/__init__.py";
  // Rust: `crate::a::b` → `src/a/b.rs` or `a/b.rs`
  const rustSegs = source.replace(/^(crate|self|super)::/, "").split("::").filter(Boolean);
  if (rustSegs.length > 0) {
    const rustPath = rustSegs.join("/") + ".rs";
    if (files.has(rustPath)) return rustPath;
    if (files.has("src/" + rustPath)) return "src/" + rustPath;
  }
  // Go: `import "a/b/c"` → look for `c/c.go` family or just `c` family
  const goSegs = source.split("/");
  if (goSegs.length > 0) {
    const last = goSegs[goSegs.length - 1];
    if (last) {
      for (const f of files) {
        if (f.endsWith("/" + last + ".go") && !f.includes("/vendor/")) return f;
      }
    }
  }
  // Java: `import a.b.C` → `a/b/C.java`
  const javaSegs = source.split(".");
  if (javaSegs.length > 0) {
    const javaPath = javaSegs.join("/") + ".java";
    if (files.has(javaPath)) return javaPath;
  }
  return null;
}

function tarjanSCC(nodes: number[], adj: Map<number, number[]>): number[][] {
  let index = 0;
  const stack: number[] = [];
  const onStack = new Set<number>();
  const indices = new Map<number, number>();
  const lowlinks = new Map<number, number>();
  const sccs: number[][] = [];
  const strongconnect = (v: number) => {
    indices.set(v, index);
    lowlinks.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);
    const neighbors = adj.get(v) ?? [];
    for (const w of neighbors) {
      if (!indices.has(w)) {
        strongconnect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v) ?? 0, lowlinks.get(w) ?? 0));
      } else if (onStack.has(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v) ?? 0, indices.get(w) ?? 0));
      }
    }
    if (lowlinks.get(v) === indices.get(v)) {
      const comp: number[] = [];
      let w: number;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      sccs.push(comp);
    }
  };
  for (const v of nodes) {
    if (!indices.has(v)) strongconnect(v);
  }
  return sccs;
}

export function checkCircularDeps(
  files: readonly ParsedFile[],
  _config: QualityConfig,
): readonly Finding[] {
  const findings: Finding[] = [];
  const filePaths = new Set(files.map((f) => f.path));
  const fileIdx = new Map<string, number>();
  files.forEach((f, i) => fileIdx.set(f.path, i));
  const adj = new Map<number, number[]>();
  files.forEach((_f, i) => adj.set(i, []));
  for (const f of files) {
    const importerIdx = fileIdx.get(f.path);
    if (importerIdx === undefined) continue;
    for (const imp of f.imports) {
      const target = resolveImportTarget(f.path, imp.source, imp.isRelative, filePaths);
      if (target === null) continue;
      const targetIdx = fileIdx.get(target);
      if (targetIdx === undefined) continue;
      if (targetIdx === importerIdx) continue;
      const arr = adj.get(importerIdx);
      if (arr) arr.push(targetIdx);
    }
  }
  const nodes = files.map((_f, i) => i);
  const sccs = tarjanSCC(nodes, adj);
  for (const scc of sccs) {
    if (scc.length < 2) continue;
    const memberPaths = scc.map((idx) => {
      const fp = files[idx];
      return fp ? fp.path : "?";
    });
    const root = memberPaths.slice().sort()[0] ?? "?";
    findings.push({
      checkId: "circular-dependency",
      severity: "error",
      filePath: root,
      line: 1,
      column: 0,
      symbol: null,
      message: `Circular dependency among ${scc.length} files`,
      extra: { cycleMembers: memberPaths, length: scc.length },
    });
  }
  return findings;
}
