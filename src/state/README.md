# State

The client state layer: the nanostores that hold every piece of reactive UI state — plain, Node-testable modules fed only by the data layer and reset through a single auto-registering registry.

## What each file does

- `auth.ts` — Auth state — multi-user dashboard login/session.
- `auto-checks.ts` — the auto-checks module.
- `chat-history-load.ts` — WHETHER THIS CONVERSATION COULD BE READ.
- `chat-history-reach.ts` — HOW FAR BACK THE READER HAS ACTUALLY READ.
- `chat-messages.ts` — Plain store — fed only by client.ts.
- `chats.ts` — Plain store — fed only by client.ts.
- `config-snapshot.ts` — Plain store — fed only by client.ts.
- `coverage.ts` — DARKFIELD + ANNUNCIATOR state.
- `cross-tab.ts` — CROSS-TAB — the one place a change made in another browser tab lands.
- `dedup.ts` — Dedup summary — the one shape owner of the call's input-dedup savings; the live latest snapshot plus the type the message record and the beat carry.
- `errors.ts` — Plain store — fed only by client.ts.
- `extensions.ts` — Extensions — fed only by client.ts at the listExtensions fetch.
- `git.ts` — Git status — fed only by client.ts at the getGitStatus fetch.
- `lens.ts` — LENS state — what the provenance instrument is currently pointing at.
- `memory.ts` — the memory module.
- `metrics.ts` — Plain store — fed only by client.ts.
- `models.ts` — LLM models + the user's selection.
- `persistence.ts` — Safe localStorage persistence for client-side UI selection state.
- `projects.ts` — Plain store — Node-testable via Vitest without any Svelte compile.
- `quality.ts` — Quality snapshot — fed only by client.ts from the "quality" SSE event.
- `redaction.ts` — Redaction notice — the one shape owner of the call's masked-input fact; the live latest snapshot plus the type the message record and the beat carry.
- `reset-all.ts` — The SINGLE owner of client-side store reset on logout.
- `run-pane.ts` — Run pane — the live data projection behind the right-docked console.
- `run-state.ts` — Plain store — Node-testable via Vitest without a Svelte compile.
- `schema-store.ts` — Schema store — nanostore holding the UI schema + current signals.
- `store-registry.ts` — Store reset registry — the SINGLE owner of the auto-registering store-reset mechanism.
- `telemetry.ts` — Client telemetry — the browser's own observability owner: uncaught errors, long tasks, feed-ingest lag and boot cost, captured at the lowest browser choke points, bounded and flushed (beacon on hide, broker POST while alive) into the server's verified ingestion door.
- `timeline-event-documents.ts` — Plain store — the recorded documents of one
  ledger event, read lazily through an injectable door; fed only by the
  BeatScope fold's open.
- `timeline-query.ts` — Plain store — fed only by client.ts.
- `timeline-refs.ts` — Plain store — fed only by client.ts.
- `tools.ts` — Tools manifest — built-in + MCP, tagged.
- `ui-control.ts` — UI-control application — the single client-side owner that maps signals to actions.
- `web-ui-config.ts` — Frontend accessor for the `webUi.graph` + `webUi.metrics` config.
- `workspaces.ts` — WORKSPACES — what the cockpit is working on, of which a page may hold many.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `src/state/`.

- `auth.ts` is consumed by `src/client.ts`, `src/cockpit/boot/Registration.svelte`, `src/cockpit/boot/probes.ts`, `src/cockpit/editor/buffer.ts`, `src/cockpit/rooms/InstrumentsRoom.svelte`.
- `auto-checks.ts` is consumed by `src/client.ts`, `src/cockpit/flow/ingest.ts`, `src/cockpit/shell/annunciator-data.ts`.
- `chat-history-load.ts` is consumed by `src/client.ts`, `src/cockpit/flow/Flow.svelte`, `src/cockpit/flow/ingest.ts`.
- `chat-history-reach.ts` is consumed by `src/client.ts`, `src/cockpit/flow/Flow.svelte`.
- `chat-messages.ts` is consumed by `src/client.ts`, `src/cockpit/desk/DeskPanel.svelte`, `src/cockpit/desk/Gauge.svelte`, `src/cockpit/desk/desk-feed.ts`, `src/cockpit/flow/Beat.svelte`, `src/cockpit/flow/Flow.svelte` and 9 more.
- `chats.ts` is consumed by `src/client.ts`, `src/cockpit/Cockpit.svelte`, `src/cockpit/boot/probes.ts`, `src/cockpit/desk/DeskPanel.svelte`, `src/cockpit/desk/Gauge.svelte`, `src/cockpit/flow/Flow.svelte` and 18 more.
- `config-snapshot.ts` is consumed by `src/cockpit/flow/RunPane.svelte`, `src/state/web-ui-config.ts`.
- `coverage.ts` is consumed by `src/cockpit/desk/desk-data.ts`, `src/cockpit/render/ToolInput.svelte`, `src/cockpit/render/artifact.ts`, `src/cockpit/render/shapes.ts`, `src/cockpit/rooms/custody-data.ts`.
- `cross-tab.ts` is consumed by `src/cockpit/rooms/instruments-feed.ts`, `src/cockpit/settings/local-prefs.ts`, `src/cockpit/shell/room-warm.ts`, `src/cockpit/sweep/sweep-store.ts`.
- `dedup.ts` is consumed by `src/client.ts`, `src/cockpit/flow/types.ts`, `src/state/chat-messages.ts`.
- `errors.ts` is consumed by `src/client.ts`.
- `extensions.ts` is consumed by `src/client.ts`.
- `git.ts` is consumed by `src/client.ts`, `src/cockpit/flow/EffectBeat.svelte`, `src/cockpit/flow/RunPane.svelte`, `src/cockpit/rooms/CustodyRoom.svelte`, `src/cockpit/rooms/DiffSheet.svelte`, `src/state/run-pane.ts`.
- `lens.ts` is consumed by `src/cockpit/computer/ask.ts`, `src/cockpit/flow/effect-findings.ts`, `src/cockpit/flow/ingest.ts`, `src/cockpit/lens/LensCallout.svelte`, `src/state/run-pane.ts`.
- `memory.ts` is consumed by `src/client.ts`.
- `metrics.ts` is consumed by `src/client.ts`.
- `models.ts` is consumed by `src/client.ts`, `src/cockpit/desk/DeskPanel.svelte`, `src/cockpit/settings/ProvidersSection.svelte`, `src/cockpit/shell/Desk.svelte`.
- `persistence.ts` is consumed by `src/cockpit/editor/buffer.ts`, `src/cockpit/flow/flow-view.ts`, `src/cockpit/rooms/instruments-feed.ts`, `src/cockpit/settings/local-prefs.ts`, `src/cockpit/shell/room-warm.ts`, `src/cockpit/shell/workspace-view.ts` and 5 more.
- `projects.ts` is consumed by `src/client.ts`, `src/cockpit/Cockpit.svelte`, `src/cockpit/boot/probes.ts`, `src/cockpit/flow/Flow.svelte`, `src/cockpit/flow/RunPane.svelte`, `src/cockpit/flow/dev/DevHarness.svelte` and 12 more.
- `quality.ts` is consumed by `src/client.ts`.
- `redaction.ts` is consumed by `src/client.ts`, `src/cockpit/flow/types.ts`, `src/state/chat-messages.ts`.
- `reset-all.ts` is consumed by `src/client.ts`.
- `run-pane.ts` is consumed by `src/cockpit/flow/RunPane.svelte`.
- `run-state.ts` is consumed by `src/client.ts`, `src/cockpit/flow/RunPane.svelte`, `src/cockpit/flow/composer-router.ts`, `src/cockpit/flow/rewind.ts`, `src/cockpit/shell/RightMenuHost.svelte`, `src/cockpit/sweep/Sweep.svelte` and 1 more.
- `schema-store.ts` is consumed by `src/client.ts`, `src/cockpit/computer/commands.ts`, `src/cockpit/flow/RunPane.svelte`, `src/cockpit/flow/ingest.ts`, `src/cockpit/lens/LensCallout.svelte`, `src/cockpit/rooms/InstrumentsRoom.svelte` and 7 more.
- `store-registry.ts` is consumed by `src/cockpit/desk/desk-bus.ts`, `src/cockpit/desk/desk-feed.ts`, `src/cockpit/editor/buffer.ts`, `src/cockpit/flow/flow-view.ts`, `src/cockpit/flow/rewind.ts`, `src/cockpit/flow/thinking-fold.ts` and 41 more.
- `telemetry.ts` is consumed by `src/client.ts`, `src/cockpit/boot/probes.ts`.
- `timeline-event-documents.ts` is consumed by `src/cockpit/flow/BeatScope.svelte`.
- `timeline-query.ts` is consumed by `src/client.ts`, `src/cockpit/flow/RunPane.svelte`, `src/cockpit/sweep/Sweep.svelte`, `src/cockpit/sweep/spectrum-load.ts`, `src/cockpit/sweep/sweep-data.ts`.
- `timeline-refs.ts` is consumed by `src/client.ts`.
- `tools.ts` is consumed by `src/client.ts`, `src/cockpit/flow/RunPane.svelte`, `src/cockpit/flow/ingest.ts`, `src/cockpit/render/ToolOutput.svelte`, `src/state/run-pane.ts`.
- `ui-control.ts` is consumed by `src/client.ts`.
- `web-ui-config.ts` is consumed by `src/cockpit/render/ArtifactFrame.svelte`, `src/state/metrics.ts`.
- `workspaces.ts` is consumed by `src/cockpit/Cockpit.svelte`, `src/cockpit/computer/admission.ts`, `src/cockpit/flow/Flow.svelte`, `src/cockpit/flow/RunPane.svelte`, `src/cockpit/flow/flow-view.ts`, `src/cockpit/flow/run-stream.ts` and 6 more.

<!-- /consumers:generated -->
