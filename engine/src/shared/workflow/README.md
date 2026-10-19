# Shared workflow

The shared workflow machinery: the canonical owners of the merge-manifest
format and the designated module-owner resolution, kept here so every
consumer imports one implementation.

## What each file does

- `e2e-runner.mjs` — the single canonical owner of the workflow end-to-end
  test runner. The suite bound is a REQUIRED input (`timeoutMs`, CLI
  `--timeout-ms`): the merge gate passes `DEFAULT_E2E_SUITE_TIMEOUT_MS` from
  `engine/src/workflow/workflow-config.ts`, and this argv-dispatching `.mjs`
  stays outside the harness module graph, so it holds no default of its own.
- `manifest-schema.mjs` — the schema and validator for the merge manifest:
  the single canonical owner of that format.
- `module-owners.mjs` — the data-driven designated module-owner resolver.
- `module-owners.json` — the data the resolver reads: which module owns
  which concern, as data so the merge is declarative.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/shared/workflow/`.

- `e2e-runner.mjs` is consumed by nothing yet.
- `manifest-schema.mjs` is consumed by nothing yet.
- `module-owners.mjs` is consumed by nothing yet.

<!-- /consumers:generated -->
