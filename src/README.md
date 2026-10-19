# Src

The Svelte client application. It renders the cockpit, talks to the server
through the thin client module (the sole caller of `fetch`/`EventSource`),
and holds its state in shared stores.

## What each file does

- `main.ts` — the application entry point: mounts the cockpit.
- `client.ts` — the thin client: the only module that performs HTTP/SSE
  calls, and the sole writer to the shared state stores.
- `client-config.ts` — the client operational configuration: the single
  source of truth for client-side tunable literals.
- `client-debug.ts` — the client debug owner: the single entry point for
  client-side debug logging, warnings, and error reporting.
- `vite-env.d.ts` — Vite and Svelte ambient type references.

## The domains

- `cockpit/` — the UI: boot, shell, flow (the chat transcript), editor,
  rooms, sweep, render, desk, and the supporting visual systems.
- `data/` — the client data layer: the broker, ledger, connection, and
  absence handling between the client and the server.
- `state/` — the shared state stores (chats, projects, models, tools, run
  state, and the rest), which auto-register for reset on context switches.

Each domain folder's own README lists its files; the consumer lists are
generated from the import graph.
