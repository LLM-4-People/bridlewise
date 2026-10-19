# C/C++ parser

The C/C++ quality parser: a real tree-sitter AST (not regex). Extracts
function definitions, `struct`/`enum`/`union`/`class`/`typedef` definitions,
and `#include` directives.

## What each file does

- `parser.ts` — the C/C++ parser on tree-sitter's real grammars.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/quality/languages/c-cpp/`.

- `parser.ts` is consumed by `engine/src/quality/languages/index.ts`.

<!-- /consumers:generated -->
