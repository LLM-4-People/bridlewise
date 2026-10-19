# Generation scripts

Generators that derive tracked artifacts from their sources, so a derived
document is regenerated rather than hand-maintained.

## What each file does

- `repository-path-unicode.ts` — generates the repository-path Unicode
  fixtures under `traceability/sources/path-policy/` from the pinned
  upstream sources (git's `path.c` and the Unicode data files), with
  canonical JSON and digest binding.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/scripts/generation/`.

- `repository-path-unicode.ts` is consumed by nothing yet.

<!-- /consumers:generated -->
