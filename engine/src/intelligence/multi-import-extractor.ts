/**
 * Multi-language import extractor — regex-based dependency detection for
 * every language the intelligence layer supports (Task 1: code graph MAJOR
 * REWRITE).
 *
 * ROOT CAUSE this fixes: `tree-sitter-extractor.ts` returned EMPTY imports
 * for all non-JS/TS languages (its comment said "a future per-language
 * import/export extractor can fill these in"). That meant `buildDependencyGraph`
 * had NO edges for Python/Rust/Go/Java/C/C++/Ruby/PHP/Swift/etc. — the graph
 * showed only isolated nodes with no connections, or "No graph data" for
 * pure non-TS repos. This module is that "future extractor."
 *
 * Design (informed by research):
 * dependency-cruiser / madge / pydeps / depends (multilang-depends) all
 * use regex-based import scanning for cross-file edges; a full AST parse
 * is overkill for edge detection (the symbol extractor already does
 * AST for symbols; imports are line-level statements).
 * ONE pure function `extractMultiLanguageImports(filePath, source)`
 * returns `ImportInfo[]` — same shape the JS/TS tokenizer produces, so
 * `buildDependencyGraph` consumes ONE unified import stream.
 * Language detection reuses `getLanguageByExtension` from the canonical
 * `language-registry.ts` (ONE owner). No hardcoded extension
 * lists here.
 * External/bare specifiers that can never resolve to a repo file (e.g.
 * Python `import os`, Rust `use std::collections`, Go `import "fmt"`,
 * Java `import java.util.*`) are filtered here so the resolver doesn't
 * waste time on them. Only relative/spec-able imports are kept.
 *
 * No new deps: pure regex + string ops. No hardcoded configurables
 *: the regex patterns are language SYNTAX, not tunable values.
 * Plain.ts — Node-testable via the node:test runner.
 */

import { deepFreeze } from "../kernel/integrity.ts";
import { getLanguageByExtension, type LanguageId } from "./language-registry.ts";
import type { ImportInfo } from "./intelligence-types.ts";

/**
 * Extract import statements from a source file using language-specific
 * regex patterns. Returns `ImportInfo[]` with `kind: "direct-import"` and
 * the raw specifier (the resolver maps it to a file path). Returns an empty
 * array for unknown languages, empty source, or files with no detectable
 * imports. Never throws — a parse failure degrades to empty (honest).
 */
export function extractMultiLanguageImports(filePath: string, source: string): readonly ImportInfo[] {
  if (typeof source !== "string" || source.length === 0) return [];
  const spec = getLanguageByExtension(filePath);
  if (spec === undefined) return [];
  const imports = extractForLanguage(spec.id, source);
  return deepFreeze(dedup(imports));
}

/** Extract imports for a specific language id. Exported for testing. */
export function extractForLanguage(lang: LanguageId, source: string): ImportInfo[] {
  switch (lang) {
    case "python": return extractPythonImports(source);
    case "rust": return extractRustImports(source);
    case "go": return extractGoImports(source);
    case "java": return extractJavaImports(source);
    case "c": return extractCImports(source);
    case "cpp": return extractCppImports(source);
    case "c_sharp": return extractCSharpImports(source);
    case "ruby": return extractRubyImports(source);
    case "php": return extractPhpImports(source);
    case "swift": return extractSwiftImports(source);
    case "kotlin": return extractKotlinImports(source);
    case "scala": return extractScalaImports(source);
    case "lua": return extractLuaImports(source);
    case "dart": return extractDartImports(source);
    case "bash": return [];
    case "elixir": return [];
    case "zig": return extractZigImports(source);
    case "ocaml": return [];
    case "elm": return extractElmImports(source);
    case "rescript": return extractRescriptImports(source);
    case "javascript": return [];
    case "typescript": return [];
  }
}

function mk(specifier: string): ImportInfo {
  return { specifier, kind: "direct-import", importedNames: [], resolvedPath: null };
}

// ── Python ──
// import foo → skip (bare, likely stdlib/third-party)
// import foo.bar → skip (bare)
// from.foo import bar → "./foo"
// from. import foo → "./"
// from..pkg import x → "../pkg"
// from foo import bar → skip (bare, unless relative)
function extractPythonImports(source: string): ImportInfo[] {
  const out: ImportInfo[] = [];
  const re = /^\s*from\s+(\.+[\w.]*)\s+import\s/mg;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const dots = m[1]!;
    // Convert Python relative import dots to a path: each dot beyond the
    // first is a parent level; the first dot is the current package.
    // from.foo import bar → 1 dot → "./foo"
    // from..pkg import x → 2 dots → "../pkg"
    // from...pkg import x → 3 dots → "../../pkg"
    // from. import foo → 1 dot, no rest → skip (self-package import)
    const dotCount = dots.length - dots.replace(/^\.+/, "").length;
    const rest = dots.slice(dotCount);
    if (rest.length === 0) continue; // from . import x → self-package, skip
    const prefix = dotCount === 1 ? "./" : "../".repeat(dotCount - 1);
    const specifier = prefix + rest.replace(/\./g, "/");
    out.push(mk(specifier));
  }
  return out;
}

// ── Rust ──
// use crate::foo::bar; → "crate::foo::bar" (resolver maps crate→src)
// use super::foo; → "super::foo" (resolver maps super→parent)
// use self::foo; → "self::foo"
// use foo::bar; → skip (external crate)
// mod foo; → "foo" (resolver maps to foo.rs or foo/mod.rs)
// mod foo::bar; → skip (invalid syntax)
// pub mod foo; → "foo"
// We keep crate::/super::/self:: + mod declarations; the resolver handles them.
function extractRustImports(source: string): ImportInfo[] {
  const out: ImportInfo[] = [];
  // use statements (crate::/super::/self:: only — external crates can't resolve)
  const useRe = /^\s*(?:pub\s+)?use\s+((?:crate|super|self|crate_self)::[\w:]+)\s*(?:;|{)/mg;
  let m: RegExpExecArray | null;
  while ((m = useRe.exec(source)) !== null) {
    out.push(mk(m[1]!));
  }
  // mod declarations (only single-identifier mods; paths in mod are rare)
  const modRe = /^\s*(?:pub\s+)?mod\s+([a-z_][a-z0-9_]*)\s*;/mg;
  while ((m = modRe.exec(source)) !== null) {
    out.push(mk(m[1]!));
  }
  return out;
}

// ── Go ──
// import "foo" → skip (bare, external)
// import "./foo" → "./foo"
// import "../foo" → "../foo"
// import (
// "fmt" → skip
// "./internal/pkg" → "./internal/pkg"
// )
// Only relative imports (./ or../) can resolve to a repo directory.
function extractGoImports(source: string): ImportInfo[] {
  const out: ImportInfo[] = [];
  // Single-line: import "./foo"
  const singleRe = /^\s*import\s+("(\.\.?\/[^"]+)")\s*$/mg;
  let m: RegExpExecArray | null;
  while ((m = singleRe.exec(source)) !== null) {
    out.push(mk(m[2]!));
  }
  // Block: import ( "fmt" \n "./foo" \n )
  const blockRe = /import\s*\(([\s\S]*?)\)/g;
  while ((m = blockRe.exec(source)) !== null) {
    const block = m[1]!;
    const lineRe = /"(\.\.?\/[^"]+)"/g;
    let lm: RegExpExecArray | null;
    while ((lm = lineRe.exec(block)) !== null) {
      out.push(mk(lm[1]!));
    }
  }
  return out;
}

// ── Java ──
// import com.foo.Bar; → "com/foo/Bar" (resolver maps to.java)
// import com.foo.*; → "com/foo" (resolver maps to dir)
// import static com.foo.Bar.baz; → "com/foo/Bar"
// Java imports are always absolute package paths; the resolver maps them
// to source files by replacing dots with slashes + appending.java.
function extractJavaImports(source: string): ImportInfo[] {
  const out: ImportInfo[] = [];
  const re = /^\s*import\s+(?:static\s+)?([\w.]+)\s*(?:\.\*)?\s*;/mg;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const spec = m[1]!;
    // Skip java/javax/sun/com.sun — standard library
    if (/^(java|javax|sun|com\.sun)\./.test(spec)) continue;
    out.push(mk(spec.replace(/\./g, "/")));
  }
  return out;
}

// ── C ──
// #include "foo.h" → "./foo.h" (resolver finds it relative to the file)
// #include <foo.h> → skip (system header)
function extractCImports(source: string): ImportInfo[] {
  const out: ImportInfo[] = [];
  const re = /^\s*#\s*include\s+"([^"]+)"\s*$/mg;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const inc = m[1]!;
    // Relative includes only; absolute paths are system/build-root
    if (inc.startsWith("/")) continue;
    out.push(mk(inc));
  }
  return out;
}

// ── C++ ── (same as C for #include; also handles #include "foo.hpp")
function extractCppImports(source: string): ImportInfo[] {
  return extractCImports(source);
}

// ── C# ──
// using Foo.Bar; → "Foo/Bar" (resolver maps to.cs)
// using static Foo.Bar; → "Foo/Bar"
// using Foo = Bar.Baz; → skip (alias, not a real dependency)
function extractCSharpImports(source: string): ImportInfo[] {
  const out: ImportInfo[] = [];
  const re = /^\s*using\s+(?:static\s+)?([\w.]+)\s*;/mg;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const spec = m[1]!;
    // Skip System.* — standard library
    if (/^System\./.test(spec)) continue;
    out.push(mk(spec.replace(/\./g, "/")));
  }
  return out;
}

// ── Ruby ──
// require_relative "foo" → "./foo" (resolver maps to.rb)
// require "foo" → skip (gem)
// load "foo.rb" → "./foo.rb" (only relative)
function extractRubyImports(source: string): ImportInfo[] {
  const out: ImportInfo[] = [];
  const relRe = /^\s*require_relative\s+["']([^"']+)["']\s*$/mg;
  let m: RegExpExecArray | null;
  while ((m = relRe.exec(source)) !== null) {
    out.push(mk(m[1]!));
  }
  const loadRe = /^\s*load\s+["'](\.[^"']+)["']\s*$/mg;
  while ((m = loadRe.exec(source)) !== null) {
    out.push(mk(m[1]!));
  }
  return out;
}

// ── PHP ──
// require "foo.php" → "foo.php" (relative)
// require_once "foo.php" → "foo.php"
// include "foo.php" → "foo.php"
// include_once "foo.php" → "foo.php"
// use Foo\Bar; → skip (PSR-4 autoload, can't map to file reliably)
function extractPhpImports(source: string): ImportInfo[] {
  const out: ImportInfo[] = [];
  const re = /^\s*(?:require|require_once|include|include_once)\s+["']([^"']+)["']\s*;?\s*$/mg;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const spec = m[1]!;
    // Absolute paths are build-root; skip
    if (spec.startsWith("/") && !spec.startsWith("./") && !spec.startsWith("../")) continue;
    out.push(mk(spec));
  }
  return out;
}

// ── Swift ──
// import Foo → skip (module, not a file path — Swift uses module maps)
// Swift's import system is module-based (Xcode/SwiftPM modules), not file-
// based. There is no reliable file-path mapping. Return empty (honest).
function extractSwiftImports(_source: string): ImportInfo[] {
  return [];
}

// ── Kotlin ──
// import com.foo.Bar → "com/foo/Bar" (resolver maps to.kt)
function extractKotlinImports(source: string): ImportInfo[] {
  const out: ImportInfo[] = [];
  const re = /^\s*import\s+([\w.]+)\s*$/mg;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const spec = m[1]!;
    // Skip kotlin/javax — standard library
    if (/^(kotlin|java|javax)\./.test(spec)) continue;
    out.push(mk(spec.replace(/\./g, "/")));
  }
  return out;
}

// ── Scala ──
// import com.foo.Bar → "com/foo/Bar"
// import com.foo.{Bar, Baz} → "com/foo" (the package, resolver maps to dir)
function extractScalaImports(source: string): ImportInfo[] {
  const out: ImportInfo[] = [];
  const re = /^\s*import\s+([\w.]+)(?:\s*\{[\w,\s]*\})?\s*$/mg;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const spec = m[1]!;
    if (/^(scala|java|javax)\./.test(spec)) continue;
    out.push(mk(spec.replace(/\./g, "/")));
  }
  return out;
}

// ── Lua ──
// require "foo" → skip (bare, package.path)
// require("foo") → skip
// dofile("foo.lua") → "foo.lua" (relative)
// loadfile("foo.lua") → "foo.lua"
function extractLuaImports(source: string): ImportInfo[] {
  const out: ImportInfo[] = [];
  const re = /^\s*(?:dofile|loadfile)\s*\(\s*["'](\.[^"']+)["']\s*\)/mg;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    out.push(mk(m[1]!));
  }
  return out;
}

// ── Dart ──
// import 'package:foo/bar.dart'; → skip (package, external)
// import './foo.dart'; → "./foo.dart"
// import '../foo.dart'; → "../foo.dart"
// export './foo.dart'; → "./foo.dart"
function extractDartImports(source: string): ImportInfo[] {
  const out: ImportInfo[] = [];
  const re = /^\s*(?:import|export)\s+["'](\.\.?[^"']+)["']\s*;/mg;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    out.push(mk(m[1]!));
  }
  return out;
}

// ── Zig ──
// const foo = @import("foo.zig"); → "foo.zig"
// @import("foo.zig") → "foo.zig"
function extractZigImports(source: string): ImportInfo[] {
  const out: ImportInfo[] = [];
  const re = /@import\("([^"]+)"\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const spec = m[1]!;
    // Skip absolute/std imports
    if (spec.startsWith("/") || spec === "std") continue;
    out.push(mk(spec));
  }
  return out;
}

// ── Elm ──
// import Foo → skip (module-based, file path is src/Foo.elm but no
// reliable mapping from module name to path without elm.json)
// Elm modules map to file paths by module name, but without the elm.json
// source-dirs config we can't resolve. Return empty (honest).
function extractElmImports(_source: string): ImportInfo[] {
  return [];
}

// ── ReScript ──
// import Foo from "./foo" → "./foo"
// import Foo from "./foo.res" → "./foo.res"
function extractRescriptImports(source: string): ImportInfo[] {
  const out: ImportInfo[] = [];
  const re = /^\s*import\s+\w+\s+from\s+"([^"]+)"\s*$/mg;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const spec = m[1]!;
    // Only relative imports
    if (!spec.startsWith(".") && !spec.startsWith("/")) continue;
    out.push(mk(spec));
  }
  return out;
}

/** Deduplicate imports by specifier (a file may import the same path twice). */
function dedup(imports: readonly ImportInfo[]): ImportInfo[] {
  const seen = new Set<string>();
  const out: ImportInfo[] = [];
  for (const imp of imports) {
    const key = `${imp.specifier}:${imp.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(imp);
  }
  return out;
}
