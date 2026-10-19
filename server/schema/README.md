# Schema

The UI schema layer: the canonical, schema-driven extension system for the web UI — the declarations and generators that derive the UI surface from data rather than hand-written components.

## What each file does

- `derive-modules.ts` — Module generators — the modules nobody authors by hand.
- `ui-declarations.ts` — UI declarations — the canonical UI surface vocabulary.
- `ui-schema.ts` — UI schema — the canonical schema-driven extension system for the web UI.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `server/schema/`.

- `derive-modules.ts` is consumed by `server/schema/ui-schema.ts`.
- `ui-declarations.ts` is consumed by `server/schema/ui-schema.ts`.
- `ui-schema.ts` is consumed by `server/blocks/settings.ts`, `server/routes/schema.ts`.

<!-- /consumers:generated -->
