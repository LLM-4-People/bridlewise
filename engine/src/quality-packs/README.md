# Quality packs

The per-language quality packs: the language-specific checks behind the shared quality contract.

## What each file does

- `bug-zoo.ts` — the bug-zoo module.
- `cli.ts` — the cli module.
- `quality-config.ts` — the quality-config module.
- `quality-pack.ts` — the quality-pack module.
- `tiers.ts` — the tiers module.
- `typescript-pack.ts` — the typescript-pack module.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/quality-packs/`.

- `bug-zoo.ts` is consumed by nothing yet.
- `cli.ts` is consumed by `engine/src/cli.ts`.
- `quality-config.ts` is consumed by `engine/src/quality-packs/prevention/duplicate-body-types.ts`.
- `quality-pack.ts` is consumed by `engine/src/quality-packs/cli.ts`, `engine/src/quality-packs/tiers.ts`, `engine/src/quality-packs/typescript-pack.ts`, `engine/src/runtime/quality-tools.ts`.
- `tiers.ts` is consumed by `engine/src/quality-packs/cli.ts`.
- `typescript-pack.ts` is consumed by `engine/src/quality-packs/cli.ts`, `engine/src/runtime/quality-tools.ts`.

<!-- /consumers:generated -->
