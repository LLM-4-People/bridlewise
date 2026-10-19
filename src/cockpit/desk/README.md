# Desk

The open desk: the context desk and breaker panel — the channel strips, gauges, and trip scopes through which a run's live controls are read and acted on.

## What each file does

- `desk-bus.ts` — DESK bus — the one seam through which another surface adds to the desk.
- `desk-config.ts` — DESK (the spec's tunable values).
- `desk-data.ts` — DESK — pure data layer.
- `desk-feed.ts` — DESK — session feed: the state machine between data and render.
- `BreakerRow.svelte` — One BREAKER ROW of the open desk — a tool of the cockpit.
- `ChannelScope.svelte` — SCOPE body for a channel strip: the real items of a source.
- `ChannelStrip.svelte` — One CHANNEL STRIP of the open desk — a context source.
- `DeskPanel.svelte` — THE OPEN DESK (context desk + breaker panel).
- `Gauge.svelte` — The closed-desk CONTEXT GAUGE.
- `ItemBody.svelte` — ONE strip item's real body — the words the next read shows.
- `TripScope.svelte` — SCOPE body for a tripped breaker's [why].

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `src/cockpit/desk/`.

- `desk-bus.ts` is consumed by `src/cockpit/desk/DeskPanel.svelte`, `src/cockpit/flow/verbs.ts`.
- `desk-config.ts` is consumed by `src/cockpit/desk/BreakerRow.svelte`, `src/cockpit/desk/ItemBody.svelte`, `src/cockpit/desk/TripScope.svelte`, `src/cockpit/desk/desk-feed.ts`, `src/cockpit/shell/room-warm.ts`.
- `desk-data.ts` is consumed by `src/cockpit/desk/BreakerRow.svelte`, `src/cockpit/desk/ChannelScope.svelte`, `src/cockpit/desk/ChannelStrip.svelte`, `src/cockpit/desk/DeskPanel.svelte`, `src/cockpit/desk/Gauge.svelte`, `src/cockpit/desk/ItemBody.svelte` and 2 more.
- `desk-feed.ts` is consumed by `src/cockpit/desk/BreakerRow.svelte`, `src/cockpit/desk/ChannelStrip.svelte`, `src/cockpit/desk/DeskPanel.svelte`, `src/cockpit/desk/Gauge.svelte`, `src/cockpit/desk/ItemBody.svelte`, `src/cockpit/shell/annunciator-data.ts`.

<!-- /consumers:generated -->
