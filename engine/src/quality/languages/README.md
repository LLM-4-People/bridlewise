# Quality language parsers

The per-language parsers of the quality pack: one folder per language, each
turning source into the parsed-file model the checks and signals consume.
The registry (`index.ts`) is the one canonical language→parser mapping —
adding a language is adding a folder and one registry entry.

## What each file does

- `index.ts` — the language parser registry.
- `semantic-form.ts` — THE SEMANTIC FORM of a file: its AST without comments and layout, read by the parser that owns its kind (Babel for JavaScript and TypeScript, tree-sitter for C, the canonical value for JSON, the words for Markdown); a kind no reader judges is said, a file that does not parse is refused. The flaky-cause owner judges a fix's change by it (FLAKE-REPRO).
- `shared-helpers.ts` — helpers shared across the language parsers.

## The subfolders

- `c-cpp/`, `go/`, `java/`, `js-ts/`, `python/`, `rust/` — the per-language
  parsers, each built on the real grammar for that language.
- `shared/` — the tree-sitter loader and AST walker the tree-sitter-backed
  parsers share.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/quality/languages/`.

- `index.ts` is consumed by `engine/src/quality/aggregator.ts`, `engine/src/quality/index.ts`.
- `semantic-form.ts` is consumed by `engine/src/git/flake-cause-fixes.ts`.
- `shared-helpers.ts` is consumed by `engine/src/quality/languages/go/parser.ts`, `engine/src/quality/languages/java/parser.ts`, `engine/src/quality/languages/rust/parser.ts`.

<!-- /consumers:generated -->
