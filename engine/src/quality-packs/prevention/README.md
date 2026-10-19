# Prevention quality packs

The prevention detectors: the experiment-derived detectors that catch defect
classes conventional checks miss — duplicate bodies, duplicated literals,
ESM/CJS hazards, dead code by digital-organism fitness, and bandaid debt.
Each detector is one module, exported through the `index.ts` barrel.

## What each file does

- `index.ts` — the barrel re-export for the prevention detectors.
- `ast-helpers.ts` — the shared AST helpers the detectors reuse.
- `async-effect-normalizer.ts` — the algebraic-effect normalizer for
  async↔sync equivalence.
- `duplicate-body-detector.ts` — the duplicate-function-body detector.
- `duplicate-body-types.ts` — the types and constants for the
  duplicate-body detector.
- `duplicated-literals-detector.ts` — the duplicated-literals detector.
- `embedding-provider.ts` — a thin adapter delegating to the canonical
  shared embeddings provider.
- `esm-cjs-detector.ts` — the ESM/CJS interop hazard detector.
- `le-chatelier-bandaid.ts` — the Le Chatelier bandaid-debt detector.
- `novel-principles-config.ts` — the configuration owner for the
  novel-principles packs.
- `tierra-dead-code.ts` — the Tierra/Avida dead-code fitness detector.
- `xenova-transformers.d.ts` — the minimal type declaration for the
  optional `@xenova/transformers` peer dependency.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/quality-packs/prevention/`.

- `ast-helpers.ts` is consumed by `engine/scripts/test-inventory.ts`, `engine/scripts/tooling/verification/governed-source.ts`, `engine/scripts/verification/architecture.ts`, `engine/scripts/verification/hermetic-skips.ts`, `engine/src/intelligence/file-slice.ts`, `engine/src/intelligence/quick-view.ts` and 15 more.
- `async-effect-normalizer.ts` is consumed by `engine/src/quality-packs/prevention/duplicate-body-detector.ts`.
- `duplicate-body-detector.ts` is consumed by `engine/src/editor/monotone-complexity-guard.ts`, `engine/src/quality-packs/prevention/index.ts`.
- `duplicate-body-types.ts` is consumed by `engine/src/quality-packs/prevention/duplicate-body-detector.ts`.
- `duplicated-literals-detector.ts` is consumed by `engine/src/quality-packs/prevention/index.ts`.
- `embedding-provider.ts` is consumed by `engine/src/quality-packs/prevention/duplicate-body-detector.ts`, `engine/src/quality-packs/prevention/index.ts`.
- `esm-cjs-detector.ts` is consumed by `engine/src/quality-packs/prevention/index.ts`.
- `index.ts` is consumed by `engine/src/quality-packs/typescript-pack.ts`.
- `le-chatelier-bandaid.ts` is consumed by nothing yet.
- `novel-principles-config.ts` is consumed by `engine/src/quality-packs/prevention/le-chatelier-bandaid.ts`, `engine/src/quality-packs/prevention/tierra-dead-code.ts`.
- `tierra-dead-code.ts` is consumed by nothing yet.
- `xenova-transformers.d.ts` is consumed by nothing yet.

<!-- /consumers:generated -->
