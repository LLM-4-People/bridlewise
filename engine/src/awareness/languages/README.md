# Awareness language adapters

The per-language adapters the awareness engine dispatches each file to. An
adapter is a pure function `(filePath, source) → FileAnalysis`; it never
touches the filesystem or holds state. Adding a language is adding one file
here and registering it in `index.ts`.

## What each file does

- `index.ts` — the language adapter registry: dispatches each file to the
  adapter whose extensions include the file's.
- `typescript.ts` — the TypeScript/JavaScript adapter, using `@babel/parser`
  (a real parser, already a dependency).
- `go.ts` / `python.ts` / `rust.ts` — the line+regex Go/Python/Rust
  adapters, kept only as fallbacks when the tree-sitter native binding is
  unavailable.
- `go-tree-sitter.ts` / `python-tree-sitter.ts` / `rust-tree-sitter.ts` —
  the real-AST Go/Python/Rust adapters built on tree-sitter.
- `tree-sitter-base.ts` — the shared real-parser infrastructure for the
  non-TypeScript tree-sitter adapters.
- `generic.ts` — the fallback adapter for any file whose extension matches
  no language adapter, so the engine never silently skips a file.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/awareness/languages/`.

- `generic.ts` is consumed by `engine/src/awareness/engine.ts`, `engine/src/awareness/languages/index.ts`.
- `go-tree-sitter.ts` is consumed by `engine/src/awareness/languages/index.ts`.
- `go.ts` is consumed by `engine/src/awareness/languages/go-tree-sitter.ts`.
- `index.ts` is consumed by `engine/src/awareness/engine.ts`.
- `python-tree-sitter.ts` is consumed by `engine/src/awareness/languages/index.ts`.
- `python.ts` is consumed by `engine/src/awareness/languages/python-tree-sitter.ts`.
- `rust-tree-sitter.ts` is consumed by `engine/src/awareness/languages/index.ts`.
- `rust.ts` is consumed by `engine/src/awareness/languages/rust-tree-sitter.ts`.
- `tree-sitter-base.ts` is consumed by `engine/src/awareness/languages/go-tree-sitter.ts`, `engine/src/awareness/languages/python-tree-sitter.ts`, `engine/src/awareness/languages/rust-tree-sitter.ts`.
- `typescript.ts` is consumed by `engine/src/awareness/languages/index.ts`.

<!-- /consumers:generated -->
