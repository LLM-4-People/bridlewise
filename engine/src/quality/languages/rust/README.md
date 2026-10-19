# Rust parser

The Rust quality parser: a real tree-sitter AST. Extracts `fn`/`impl`/
`struct`/`enum` definitions and `use` imports.

## What each file does

- `parser.ts` — the Rust parser on tree-sitter's real grammar.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/quality/languages/rust/`.

- `parser.ts` is consumed by `engine/src/quality/languages/index.ts`.

<!-- /consumers:generated -->
