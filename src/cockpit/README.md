# Cockpit

The cockpit: the web UI's interactive shell — the HORIZON, FLOW, SWEEP, DESK grammar that renders a run as a live causal stream rather than a static log.

## What each file does

- `Cockpit.svelte` — COCKPIT root — the shell grammar: HORIZON · FLOW · SWEEP.
- `main.ts` — COCKPIT entry — mounts the shell.

The cockpit's rooms and surfaces live one level down, each a populated subfolder with its own README.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `src/cockpit/`.

- `main.ts` is consumed by `src/main.ts`.

<!-- /consumers:generated -->
