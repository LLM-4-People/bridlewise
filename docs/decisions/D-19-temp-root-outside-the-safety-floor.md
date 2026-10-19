---
id: D-19
date: 2026-09-29
by: coordinator
group: process
status: in-force
implementation: done
acted_in: [engine/src/filesystem/temporary-root.ts, engine/scripts/tooling/run-tests.ts, scripts/run-tests.ts, server/kernel/boot-settings-preflight.ts]
---
# A process's temp root lies outside the safety floor

`~/.local/state/bridlewise-*` is inside the safety floor's keep-out wildcard,
so a temp root there makes the harness refuse its own temporary files. Test
runs use a private temp root outside the floor, `~/.cache/bridlewise-tmp/<task>`
(0700), never the shared `/tmp` when it is full; the runners and the server
boot refuse a temp root inside the floor (TMPDIR-KEEPOUT-001).
