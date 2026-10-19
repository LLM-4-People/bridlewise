# Rooms

The cockpit rooms: the full-screen surfaces summoned by key — custody, editor, folder picker, instruments, settings, and the switch — each a self-contained workspace.

## What each file does

- `custody-config.ts` — CUSTODY (the spec's tunable values).
- `custody-data.ts` — CUSTODY — pure data helpers.
- `custody-feed.ts` — CUSTODY — session feed.
- `folder-picker.ts` — THE FOLDER PICKER — pure state machine, no DOM and no fetch.
- `instruments-config.ts` — INSTRUMENTS — tunable numeric constants.
- `instruments-data.ts` — INSTRUMENTS — pure helpers.
- `instruments-feed.ts` — INSTRUMENTS — the live signal feed.
- `micro-bins.ts` — THE SWITCH — micro-sweep density decode.
- `setting-sheet-seam.ts` — INSTRUMENTS — the setting-sheet seam.
- `switch-config.ts` — THE SWITCH (the spec's values + time-unit anchors).
- `switch-data.ts` — THE SWITCH — pure river helpers.
- `switch-feed.ts` — THE SWITCH — session feeds.
- `switch-outcome.ts` — THE SWITCH — the reel's measured outcome line.
- `CustodyRoom.svelte` — THE CUSTODY ROOM — status as verbs.
- `DiffSheet.svelte` — SCOPE diff body.
- `EditorRoom.svelte` — THE EDITOR ROOM — the project's files, and what you can do.
- `FolderPicker.svelte` — THE FOLDER PICKER — choose a folder on the server's disk.
- `InstrumentCell.svelte` — INSTRUMENTS — one instrument cell.
- `InstrumentsRoom.svelte` — THE INSTRUMENTS ROOM — the honest dashboard.
- `MicroSweep.svelte` — THE SWITCH — a reel's 24px micro-sweep.
- `Monitor.svelte` — INSTRUMENTS — the pinned-monitor reference.
- `Parcel.svelte` — CUSTODY — one work parcel.
- `recycle-confirm.ts` — THE RECYCLE CONFIRM — two-press door + armed face.
- `Reel.svelte` — THE SWITCH — one reel: a conversation with its measures.
- `SettingsRoom.svelte` — THE SETTINGS INDEX — one searchable sheet.
- `Spark.svelte` — INSTRUMENTS — the spark.
- `SwitchRoom.svelte` — THE SWITCH — the one navigation gesture.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `src/cockpit/rooms/`.

- `custody-config.ts` is consumed by `src/cockpit/flow/verbs.ts`, `src/cockpit/rooms/CustodyRoom.svelte`, `src/cockpit/rooms/Parcel.svelte`, `src/cockpit/rooms/custody-data.ts`, `src/cockpit/rooms/custody-feed.ts`, `src/cockpit/shell/room-warm.ts`.
- `custody-data.ts` is consumed by `src/cockpit/flow/verbs.ts`, `src/cockpit/rooms/CustodyRoom.svelte`, `src/cockpit/rooms/DiffSheet.svelte`, `src/cockpit/rooms/Parcel.svelte`, `src/cockpit/rooms/custody-feed.ts`.
- `custody-feed.ts` is consumed by `src/cockpit/rooms/CustodyRoom.svelte`, `src/cockpit/rooms/Reel.svelte`, `src/cockpit/rooms/SwitchRoom.svelte`.
- `folder-picker.ts` is consumed by `src/cockpit/rooms/FolderPicker.svelte`.
- `instruments-config.ts` is consumed by `src/cockpit/rooms/InstrumentsRoom.svelte`, `src/cockpit/rooms/Spark.svelte`, `src/cockpit/rooms/instruments-data.ts`, `src/cockpit/rooms/instruments-feed.ts`.
- `instruments-data.ts` is consumed by `src/cockpit/lens/lens-callout-data.ts`, `src/cockpit/rooms/InstrumentCell.svelte`, `src/cockpit/rooms/InstrumentsRoom.svelte`, `src/cockpit/rooms/Monitor.svelte`, `src/cockpit/rooms/Spark.svelte`, `src/cockpit/rooms/instruments-feed.ts`.
- `instruments-feed.ts` is consumed by `src/cockpit/rooms/InstrumentCell.svelte`, `src/cockpit/rooms/InstrumentsRoom.svelte`.
- `micro-bins.ts` is consumed by `src/cockpit/rooms/MicroSweep.svelte`, `src/cockpit/rooms/switch-feed.ts`.
- `recycle-confirm.ts` is consumed by `src/cockpit/rooms/Reel.svelte`, `src/cockpit/rooms/SwitchRoom.svelte`.
- `setting-sheet-seam.ts` is consumed by `src/cockpit/rooms/InstrumentCell.svelte`, `src/cockpit/rooms/InstrumentsRoom.svelte`.
- `switch-config.ts` is consumed by `src/cockpit/rooms/SwitchRoom.svelte`, `src/cockpit/rooms/recycle-confirm.ts`, `src/cockpit/rooms/switch-data.ts`, `src/cockpit/rooms/switch-feed.ts`, `src/cockpit/shell/room-warm.ts`.
- `switch-data.ts` is consumed by `src/cockpit/rooms/CustodyRoom.svelte`, `src/cockpit/rooms/Reel.svelte`, `src/cockpit/rooms/SwitchRoom.svelte`, `src/cockpit/rooms/switch-feed.ts`.
- `switch-feed.ts` is consumed by `src/cockpit/rooms/MicroSweep.svelte`, `src/cockpit/rooms/Reel.svelte`, `src/cockpit/rooms/SwitchRoom.svelte`.
- `switch-outcome.ts` is consumed by `src/cockpit/rooms/micro-bins.ts`, `src/cockpit/rooms/switch-feed.ts`.

<!-- /consumers:generated -->
