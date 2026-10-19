# Settings

The settings surface: the setting sheet and settings index — adjust-in-place openers, local preferences, the provider section and the tool server list, backed by one data door.

## What each file does

- `local-prefs.ts` — Cockpit-local preferences.
- `open.ts` — Adjust-in-place openers.
- `settings-config.ts` — THE SETTINGS INDEX (the spec's values).
- `settings-data.ts` — Settings data — pure helpers behind the setting sheet.
- `settings-feed.ts` — Settings feed — the settings surfaces' one data door.
- `McpServersSection.svelte` — CONNECTED TOOL SERVERS — the MCP category's servers list (add / edit / test / remove).
- `ProvidersSection.svelte` — MODEL PROVIDERS — the settings room's provider section.
- `SettingSheet.svelte` — THE SETTING SHEET — the one sheet primitive.
- `DiagnosticModesSection.svelte` — DIAGNOSTIC MODES — positive inclusion switches, saved through the canonical exclusion-list door.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `src/cockpit/settings/`.

- `local-prefs.ts` is consumed by `src/cockpit/rooms/EditorRoom.svelte`, `src/cockpit/rooms/SettingsRoom.svelte`, `src/cockpit/settings/SettingSheet.svelte`, `src/cockpit/settings/open.ts`, `src/state/ui-control.ts`.
- `open.ts` is consumed by `src/cockpit/Cockpit.svelte`, `src/cockpit/lens/LensCallout.svelte`.
- `settings-config.ts` is consumed by `src/cockpit/rooms/SettingsRoom.svelte`, `src/cockpit/settings/McpServersSection.svelte`, `src/cockpit/settings/ProvidersSection.svelte`, `src/cockpit/settings/SettingSheet.svelte`.
- `settings-data.ts` is consumed by `src/cockpit/lens/lens-callout-data.ts`, `src/cockpit/rooms/SettingsRoom.svelte`, `src/cockpit/settings/DiagnosticModesSection.svelte`, `src/cockpit/settings/ProvidersSection.svelte`, `src/cockpit/settings/SettingSheet.svelte`, `src/cockpit/settings/local-prefs.ts` and 2 more.
- `settings-feed.ts` is consumed by `src/cockpit/rooms/SettingsRoom.svelte`, `src/cockpit/settings/DiagnosticModesSection.svelte`, `src/cockpit/settings/SettingSheet.svelte`, `src/cockpit/settings/open.ts`.

<!-- /consumers:generated -->

## Shared editing behavior

The exact value and commit action stay together. At desktop width, the description and labeled scope/effect facts occupy the adjacent column; compact layouts stack these groups. Unchanged defaults stay implicit. Custom values have a text cue, with the original default and Reset in the editor. Unread values remain explicitly unread. Details holds bounds, measured effects and the last-save timestamp when present. Next-run, restart and undeclared timing remain visible beside the editor. Saved has readable semantic color and local polite feedback; a newer draft remains distinct from the earlier confirmed operation.

Provider and MCP forms own their opening generation, draft revision and pending request. An earlier success closes only its unchanged form; later input, rows and choices remain editable. Test work and verdicts are keyed with SvelteMap, including valid prototype-shaped entity names. Pending work remains per entity, and save/delete invalidates an older verdict. Native input is the form-wide draft event; select change also updates its binding without a second revision bump.
