# Java parser

The Java quality parser: a real tree-sitter AST. Extracts class and method
definitions, fields, and imports.

## What each file does

- `parser.ts` — the Java parser on tree-sitter's real grammar.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/quality/languages/java/`.

- `parser.ts` is consumed by `engine/src/quality/languages/index.ts`.

<!-- /consumers:generated -->
