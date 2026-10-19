# Python parser

The Python quality parser: a real tree-sitter AST. Extracts function and
class definitions, imports, and type annotations.

## What each file does

- `parser.ts` — the Python parser on tree-sitter's real grammar.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/quality/languages/python/`.

- `parser.ts` is consumed by `engine/src/quality/languages/index.ts`.

<!-- /consumers:generated -->
