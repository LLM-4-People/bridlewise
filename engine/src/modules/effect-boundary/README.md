# Effect boundary

The effect-boundary module: owns the exact-write-lease authority — the declared, content-hashed lease that governs a precise write to the tree.

## What each file does

- `index.ts` — Re-exports the exact-write-lease authority stage.

The module's domain logic lives one level down:

- `domain/` — the exact-write-lease schema and authority.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/modules/effect-boundary/`.

- `index.ts` is consumed by nothing yet.

<!-- /consumers:generated -->
