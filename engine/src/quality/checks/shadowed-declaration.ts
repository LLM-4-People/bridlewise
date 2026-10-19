/**
 * Shadowed-declaration check (EXP386).
 *
 * Detects a local declaration that re-binds a name already in scope from an
 * enclosing block or an import. Common shape across languages:
 * - JS/TS: `let x` / `const x` / `var x` where `x` was already declared
 * in an outer scope or imported. (`var` re-declaration is legal
 * but a readability hazard; `let/const` shadowing is a known bug
 * source — the inner binding hides the outer one.)
 * - Python: assignment to a name imported at module top-level inside a
 * function (without `global`/`nonlocal`). The local binding
 * shadows the import.
 * - Rust: `let` of a name already bound in an outer scope or `use`d.
 * - Go: `:=` short declaration shadowing an outer `var`.
 * - Java: local variable with the same name as a field or import.
 * - C/C++: local variable with the same name as a file-scope symbol.
 *
 * The check uses a scope-stack walk over the line text (no AST scope
 * information — language-agnostic). For each declaration, it flags if the
 * same name was already declared at a strictly outer scope (lower nesting
 * depth) or imported at file scope.
 *
 * False-positive avoidance:
 * - Skip function parameters (they are not "shadowing"; they declare the
 * name in the function's own scope).
 * - Skip names that begin with `_` (intentional "unused" convention).
 * - Skip re-declaration at the SAME indent (the previous `let` is dead,
 * not shadowed — the dead-code check handles that).
 * - Skip declarations inside the same block where the name was first
 * declared at the same depth (that's re-declaration, not shadowing).
 */

import type { Finding, ParsedFile, QualityConfig } from "../base.ts";
import { leadingSpaces } from "./shared-helpers.ts";

interface ScopeEntry {
  name: string;
  indent: number;
  line: number;
}

const DECL_RE = /\b(let|const|var)\s+([A-Za-z_]\w*)\b/g;
const PY_ASSIGN_RE = /^\s*([A-Za-z_]\w*)\s*=/;
const RUST_LET_RE = /\blet\s+(?:mut\s+)?([A-Za-z_]\w*)\b/;
const GO_SHORT_RE = /([A-Za-z_]\w*)\s*:?=/;
// C/C++ type-keyword list. `long long`, `unsigned long`, `signed int` are
// multi-word types — we consume any prefix of these keywords before the
// actual variable name. The optional `*` for pointer decls comes AFTER
// all type keywords, right before the variable name (`const char *str`,
// `unsigned long long *i`). We also skip declarations of function
// pointers (the "name" is in `(*name)(...)`) and cast expressions.
const C_TYPE_KEYWORDS = new Set([
  "int", "long", "short", "char", "float", "double", "size_t",
  "void", "bool", "auto", "unsigned", "signed", "const", "static",
  "extern", "inline", "register", "volatile",
]);
const C_DECL_RE = /\b(int|long|short|char|float|double|size_t|void|bool|auto|unsigned|signed|const|static|extern|inline|register|volatile)\b\s*(?:\b(?:int|long|short|char|float|double|size_t|void|bool|unsigned|signed|const|static|extern|inline|register|volatile)\b\s*)*(?:\*+\s*)?([A-Za-z_]\w*)\b/;
const JAVA_DECL_RE = /\b(int|long|short|char|float|double|boolean|byte|var|String)\s+([A-Za-z_]\w*)\b/;

export function checkShadowedDeclarations(
  files: readonly ParsedFile[],
  _config: QualityConfig,
): readonly Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    const lines = f.content.split("\n");
    // File-scope imports — collected from ParsedFile.imports.
    const importedNames = new Set<string>();
    for (const imp of f.imports) {
      for (const n of imp.names) importedNames.add(n);
    }
    // Scope stack — entries with strictly-increasing indent.
    const stack: ScopeEntry[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (!line.trim()) continue;
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
      const indent = leadingSpaces(line);
      // Pop scopes that are strictly outer (lower indent). NOTE: we use
      // strict `>` instead of `>=` so that sibling statements at the same
      // indent don't pop each other. A function definition at the same
      // indent as a local (`def inner:` and `x = 1` both at indent 4
      // inside `def outer:`) does NOT close the local's scope — the
      // local is still in the enclosing function's body, accessible to
      // the nested function via closure (Python, JS, etc.). Using `>=`
      // would incorrectly pop the local when we see the sibling `def`
      // line, missing real shadowing inside the nested function.
      while (stack.length > 0 && stack[stack.length - 1]!.indent > indent) {
        stack.pop();
      }
      // Collect declarations on this line.
      const decls: Array<{ name: string; col: number }> = [];
      if (f.language === "python") {
        const m = line.match(PY_ASSIGN_RE);
        if (m && m[1] && !m[1].startsWith("_")) {
          decls.push({ name: m[1], col: line.indexOf(m[1]) });
        }
      } else if (f.language === "rust") {
        const m = line.match(RUST_LET_RE);
        if (m && m[1] && !m[1].startsWith("_")) {
          decls.push({ name: m[1], col: line.indexOf(m[1]) });
        }
      } else if (f.language === "go") {
        // `:=` short decl OR `var x` decl. Skip function params.
        if (!/^\s*func\b/.test(line)) {
          const m = line.match(GO_SHORT_RE);
          if (m && m[1] && !m[1].startsWith("_") && m[1] !== "_") {
            decls.push({ name: m[1], col: line.indexOf(m[1]) });
          }
        }
      } else if (f.language === "c" || f.language === "cpp") {
        if (!/^\s*(int|long|short|char|float|double|size_t|void|bool)\s*\(/.test(line)) {
          const m = line.match(C_DECL_RE);
          if (m && m[2] && !m[2].startsWith("_") && !C_TYPE_KEYWORDS.has(m[2])) {
            // If the captured name is followed by ` *`, the captured name
            // is actually a TYPE (typedef'd), not a variable. The real
            // variable is the identifier AFTER the `*`. Re-parse to find it.
            const matchEnd = (m.index ?? 0) + m[0].length;
            const after = line.slice(matchEnd);
            const ptrMatch = after.match(/^\s*\*+\s*([A-Za-z_]\w*)/);
            if (ptrMatch && ptrMatch[1] && !C_TYPE_KEYWORDS.has(ptrMatch[1]) && !ptrMatch[1].startsWith("_")) {
              // `Type *var` — the variable is `var`, not the captured name.
              const col = matchEnd + (ptrMatch.index ?? 0) + (ptrMatch[0].length - ptrMatch[1].length);
              decls.push({ name: ptrMatch[1], col });
            } else if (!ptrMatch) {
              // No `*` after the captured name — it's the real variable.
              decls.push({ name: m[2], col: line.indexOf(m[2], m.index ?? 0) });
            }
            // If ptrMatch exists but the var name is a type keyword or
            // starts with `_`, skip this decl entirely.
          }
        }
      } else if (f.language === "java") {
        if (!/^\s*(public|private|protected|static)\s/.test(line)) {
          const m = line.match(JAVA_DECL_RE);
          if (m && m[2] && !m[2].startsWith("_")) {
            decls.push({ name: m[2], col: line.indexOf(m[2]) });
          }
        }
      } else {
        // JS/TS — `let/const/var` declarations.
        let m: RegExpExecArray | null;
        DECL_RE.lastIndex = 0;
        while ((m = DECL_RE.exec(line)) !== null) {
          const name = m[2];
          if (name && !name.startsWith("_")) {
            decls.push({ name, col: m.index });
          }
        }
      }
      for (const d of decls) {
        // Check against file-scope imports.
        if (importedNames.has(d.name)) {
          findings.push({
            checkId: "shadowed-declaration",
            severity: "warning",
            filePath: f.path,
            line: i + 1,
            column: d.col + 1,
            symbol: d.name,
            message: `Local declaration '${d.name}' shadows an imported name`,
            extra: { file: f.path, shadows: "import" },
          });
          continue;
        }
        // Check against outer-scope declarations on the stack. Only an
        // entry at STRICTLY less indent (enclosing scope) is shadowing;
        // an entry at the same indent is a sibling or re-assignment,
        // not shadowing.
        let shadowed = false;
        for (let k = stack.length - 1; k >= 0; k -= 1) {
          if (stack[k]!.indent === indent) continue; // sibling, skip
          if (stack[k]!.name === d.name) {
            shadowed = true;
            break;
          }
        }
        if (shadowed) {
          findings.push({
            checkId: "shadowed-declaration",
            severity: "info",
            filePath: f.path,
            line: i + 1,
            column: d.col + 1,
            symbol: d.name,
            message: `Local declaration '${d.name}' shadows an outer-scope binding`,
            extra: { file: f.path, shadows: "scope" },
          });
        }
        stack.push({ name: d.name, indent, line: i + 1 });
      }
    }
  }
  return findings;
}
