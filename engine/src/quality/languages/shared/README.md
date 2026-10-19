# Shared tree-sitter machinery

The tree-sitter infrastructure the tree-sitter-backed language parsers
share, owned once so a loader or walker fix reaches every language.

## What each file does

- `tree-sitter-loader.ts` — the single owner for tree-sitter
  initialization, language-WASM loading, and the parser pool.
- `tree-sitter-walker.ts` — the generic AST-walking helpers that are not
  language-specific.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/quality/languages/shared/`.

- `tree-sitter-loader.ts` is consumed by `engine/src/quality/languages/c-cpp/parser.ts`, `engine/src/quality/languages/go/parser.ts`, `engine/src/quality/languages/java/parser.ts`, `engine/src/quality/languages/python/parser.ts`, `engine/src/quality/languages/rust/parser.ts`, `engine/src/quality/languages/semantic-form.ts` and 1 more.
- `tree-sitter-walker.ts` is consumed by `engine/src/quality/languages/c-cpp/parser.ts`, `engine/src/quality/languages/go/parser.ts`, `engine/src/quality/languages/java/parser.ts`, `engine/src/quality/languages/js-ts/parser.ts`, `engine/src/quality/languages/python/parser.ts`, `engine/src/quality/languages/rust/parser.ts`.

<!-- /consumers:generated -->
