# JS/TS parser

The JavaScript/TypeScript quality parser: a real AST via `@babel/parser`,
reusing the shared AST helpers. Extracts functions, classes, imports,
exports, and type annotations.

## What each file does

- `parser.ts` — the JS/TS parser on `@babel/parser`.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/quality/languages/js-ts/`.

- `parser.ts` is consumed by `engine/src/quality/languages/index.ts`.

<!-- /consumers:generated -->
