# Paint

The cockpit paint layer: the single owner of the design tokens, read from the canvas rather than re-declared per component.

## What each file does

- `design-tokens.ts` — READING A DESIGN TOKEN FROM A CANVAS — the one owner.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `src/cockpit/paint/`.

- `design-tokens.ts` is consumed by `src/cockpit/rooms/MicroSweep.svelte`, `src/cockpit/rooms/Spark.svelte`, `src/cockpit/rooms/SwitchRoom.svelte`, `src/cockpit/sweep/Sweep.svelte`, `src/cockpit/sweep/categories.ts`.

<!-- /consumers:generated -->
