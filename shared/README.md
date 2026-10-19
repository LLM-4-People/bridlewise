# Shared

The wire contracts and shared declarations that both the server and the
client import. One capability, route, error code, or payload shape is
declared once here and consumed on both sides of the HTTP boundary, so the
two cannot drift.

## What each file does

- `routes.ts` — the canonical route list: the single source of truth for the
  set of surfaces the UI can show.
- `types.ts` — type-only re-exports from the canonical engine source, so
  event and state types originate in one place.
- `wire-types.ts` — the pure data shapes that cross the HTTP boundary from
  server to client.
- `input-schemas.ts` — the wire-input zod schemas and derived types for the
  request bodies the client sends.
- `ui-schema.ts` — the UI schema wire types shared by the server (schema
  builder) and the client (renderer), plus the schema version.
- `module-contract.ts` — the module contract: one declaration per UI
  surface, shared server↔client.
- `block-contract.ts` — the block contract: one declaration emits every
  projection of a unit of backend capability.
- `event-types.ts` — the inline event-kind vocabulary shown in the chat
  transcript (hallucination, steering, and friends).
- `errors.ts` — the error taxonomy: one code set shared by the server and
  the client.
- `constants.ts` — the shared protocol and schema constants consumed by more
  than one module.
- `provenance.ts` — the provenance contract: the shape of "where did this
  value come from".
- `when-eval.ts` — the when-clause evaluator: the declarative visibility
  predicate language UI schema entries carry.
- `html-preview.ts` — the config-reader half of the untrusted-HTML iframe
  sandbox hardening.
- `web-ui-types.ts` — web-UI-local pure shared types with no dependency on
  the engine.
- `web-ui-defaults.ts` — the web-UI tunable defaults and readers, shared
  server↔client.
- `markdown.ts` — THE ONE MARKDOWN PARSER: markdown → plain nodes for the
  cockpit renderer, and `extractMarkdown` (links, reference definitions, code
  spans, with lines) for the repository's dead-link and briefing checks.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `shared/`.

- `arm-vocabulary.ts` is consumed by `server/blocks/arm.ts`, `src/cockpit/sweep/arm-fire.ts`, `src/cockpit/sweep/arm-palette.ts`.
- `block-contract.ts` is consumed by `server/blocks/define.ts`, `src/cockpit/computer/commands.ts`, `src/cockpit/rooms/instruments-data.ts`, `src/cockpit/settings/settings-data.ts`, `src/data/broker.ts`.
- `constants.ts` is consumed by `engine/src/performance/diagnostic-modes.ts`, `engine/src/timeline/effect-documents.ts`, `engine/src/timeline/ledger-dig.ts`, `engine/src/timeline/timeline-recorder.ts`, `engine/src/timeline/timeline-store.ts`, `engine/src/timeline/timeline-types.ts` and 39 more.
- `errors.ts` is consumed by `server/blocks/define.ts`, `server/kernel/errors.ts`, `server/router/sse.ts`, `server/run/run-executor.ts`, `src/client.ts`, `src/data/absence.ts` and 2 more.
- `event-types.ts` is consumed by `server/db/schema.ts`, `server/run/run-executor.ts`, `server/safety/safety-bridge.ts`, `src/client.ts`, `src/cockpit/flow/ingest.ts`, `src/cockpit/flow/types.ts` and 2 more.
- `html-preview.ts` is consumed by `src/state/web-ui-config.ts`.
- `input-schemas.ts` is consumed by `server/routes/auto-checks.ts`, `server/routes/chats.ts`, `server/routes/projects.ts`, `src/state/auto-checks.ts`, `src/state/chats.ts`, `src/state/projects.ts`.
- `markdown.ts` is consumed by `engine/src/workflow/record-links.ts`, `src/cockpit/render/MdBlocks.svelte`, `src/cockpit/render/MdInline.svelte`, `src/cockpit/render/Prose.svelte`, `src/cockpit/render/StreamText.svelte`.
- `module-contract.ts` is consumed by `server/schema/derive-modules.ts`, `server/schema/ui-declarations.ts`, `src/cockpit/rooms/instruments-data.ts`, `src/cockpit/settings/settings-data.ts`, `src/state/schema-store.ts`.
- `provenance.ts` is consumed by `server/blocks/provenance.ts`, `src/cockpit/lens/LensCallout.svelte`, `src/cockpit/lens/lens-callout-data.ts`, `src/data/broker.ts`, `src/data/ledger.ts`, `src/state/lens.ts`.
- `routes.ts` is consumed by `server/tools/ui-control.ts`, `src/cockpit/desk/DeskPanel.svelte`, `src/cockpit/flow/RunPane.svelte`, `src/cockpit/shell/RightMenuHost.svelte`, `src/cockpit/shell/right-menu.ts`, `src/cockpit/shell/view-request.ts` and 3 more.
- `types.ts` is consumed by `src/client.ts`, `src/cockpit/desk/TripScope.svelte`, `src/cockpit/flow/RunPane.svelte`, `src/cockpit/flow/run-stream.ts`, `src/state/chat-messages.ts`, `src/state/config-snapshot.ts` and 6 more.
- `ui-schema.ts` is consumed by `server/schema/ui-declarations.ts`, `server/schema/ui-schema.ts`, `src/client.ts`, `src/cockpit/lens/lens-callout-data.ts`, `src/cockpit/rooms/InstrumentCell.svelte`, `src/cockpit/rooms/InstrumentsRoom.svelte` and 5 more.
- `web-ui-defaults.ts` is consumed by `server/kernel/harness-config.ts`, `src/state/web-ui-config.ts`.
- `web-ui-types.ts` is consumed by `server/kernel/harness-config.ts`.
- `when-eval.ts` is consumed by `server/blocks/arm.ts`, `src/cockpit/sweep/arm-fire.ts`, `src/cockpit/sweep/arm-palette.ts`.
- `wire-types.ts` is consumed by `server/blocks/compose.ts`, `server/context/memory-bridge.ts`, `server/filesystem/editor-bridge.ts`, `server/integrations/mcp-bridge.ts`, `server/integrations/mcp-runtime-bridge.ts`, `server/kernel/harness-config.ts` and 13 more.

<!-- /consumers:generated -->
