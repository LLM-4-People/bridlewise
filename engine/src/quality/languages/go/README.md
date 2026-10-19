# Go parser

The Go quality parser: a real tree-sitter AST. Extracts function
definitions, types, and imports.

## What each file does

- `parser.ts` — the Go parser on tree-sitter's real grammar.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/quality/languages/go/`.

- `parser.ts` is consumed by `engine/src/quality/languages/index.ts`.

<!-- /consumers:generated -->
