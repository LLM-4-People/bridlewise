# Computer

The cockpit computer: the finding-admission controller — the `?` and `/` grammars, the derivation contract, and the client-computable findings the surface can answer.

## What each file does

- `admission.ts` — COCKPIT COMPUTER — the finding admission controller.
- `ask.ts` — COCKPIT COMPUTER — the `?` grammar.
- `commands.ts` — COCKPIT COMPUTER — the `/` grammar.
- `computer-config.ts` — The admission controller's damping constants, owned here.
- `derivation.ts` — COCKPIT COMPUTER — the derivation contract.
- `findings.ts` — COCKPIT COMPUTER — client-computable findings.
- `FindingNote.svelte` — LENS-level deep finding note.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `src/cockpit/computer/`.

- `admission.ts` is consumed by `src/cockpit/flow/Flow.svelte`, `src/cockpit/flow/dock.ts`, `src/cockpit/flow/ingest.ts`, `src/cockpit/sweep/arm-fire.ts`.
- `ask.ts` is consumed by `src/cockpit/flow/composer-router.ts`, `src/cockpit/lens/lens-callout-data.ts`, `src/cockpit/rooms/instruments-data.ts`.
- `commands.ts` is consumed by `src/cockpit/flow/composer-router.ts`.
- `computer-config.ts` is consumed by `src/cockpit/computer/admission.ts`.
- `derivation.ts` is consumed by `src/cockpit/computer/FindingNote.svelte`, `src/cockpit/computer/findings.ts`, `src/cockpit/flow/types.ts`.
- `findings.ts` is consumed by `src/cockpit/computer/ask.ts`, `src/cockpit/flow/DeskLine.svelte`, `src/cockpit/flow/Flow.svelte`, `src/cockpit/flow/composer-router.ts`, `src/cockpit/flow/ingest.ts`.

<!-- /consumers:generated -->
