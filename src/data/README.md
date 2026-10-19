# Data

The client data layer: the single owners of the client's connection to the server, its I/O, its clock, and the honest vocabulary it uses when there is nothing to show.

## What each file does

- `absence.ts` — FAILURE → PLAIN WORDS. The single owner of "why is there nothing here".
- `asof.ts` — THE GLOBAL `asOf` — one owner for "which instant am I looking at".
- `broker.ts` — The Broker — the single place the client performs I/O.
- `connection.ts` — THE CONNECTION — one global state, one owner.
- `error-messages.ts` — Error message formatting — the client's human-text projection of errors.
- `errors.ts` — Client error classes — the typed errors the data layer throws.
- `ledger.ts` — The provenance LEDGER — what the Broker knows, kept where LENS can read it.
- `liveness-share.ts` — THE LIVENESS SHARE — one elected tab per browser context holds the liveness socket (Web Locks + BroadcastChannel); the others derive the same state from its broadcasts (UIE-044).

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `src/data/`.

- `absence.ts` is consumed by `src/client.ts`, `src/cockpit/desk/desk-feed.ts`, `src/cockpit/editor/feed.ts`, `src/cockpit/flow/composer-router.ts`, `src/cockpit/flow/run-stream.ts`, `src/cockpit/rooms/InstrumentsRoom.svelte` and 9 more.
- `asof.ts` is consumed by `src/cockpit/Cockpit.svelte`, `src/cockpit/desk/BreakerRow.svelte`, `src/cockpit/desk/ChannelStrip.svelte`, `src/cockpit/desk/DeskPanel.svelte`, `src/cockpit/desk/Gauge.svelte`, `src/cockpit/flow/Flow.svelte` and 22 more.
- `broker.ts` is consumed by `src/client.ts`, `src/cockpit/computer/ask.ts`, `src/cockpit/computer/commands.ts`, `src/cockpit/desk/TripScope.svelte`, `src/cockpit/desk/desk-feed.ts`, `src/cockpit/flow/EffectBeat.svelte` and 17 more.
- `connection.ts` is consumed by `src/cockpit/Cockpit.svelte`, `src/cockpit/main.ts`, `src/cockpit/shell/ConnectionBlock.svelte`, `src/data/broker.ts`.
- `error-messages.ts` is consumed by `src/client.ts`.
- `errors.ts` is consumed by `src/client.ts`, `src/cockpit/boot/probes.ts`, `src/cockpit/computer/ask.ts`, `src/cockpit/computer/derivation.ts`, `src/cockpit/flow/Verb.svelte`, `src/cockpit/flow/log.ts` and 17 more.
- `ledger.ts` is consumed by `src/data/broker.ts`, `src/state/lens.ts`.
- `liveness-share.ts` is consumed by `src/data/connection.ts`.

<!-- /consumers:generated -->
