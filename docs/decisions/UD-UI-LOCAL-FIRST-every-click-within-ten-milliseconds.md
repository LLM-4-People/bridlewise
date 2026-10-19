---
id: UD-UI-LOCAL-FIRST
date: 2026-10-07
by: user
group: labs
status: in-force
implementation: pending
route: WEB-EFFICIENCY
---
# Every click within ten milliseconds: a local-first UI

The user's targets of 2026-10-07 (PLAN.md, "USER TARGETS (2026-10-07, UI)"):

- **No screen waits on data.** At most 10 ms of main-thread work for 100% of
  clicks (click → handler → state → DOM commit), in every part of the page.
  The paint on the next frame is reported, not promised.
- **A local-first UI.** A client replica is kept current by the one server
  stream; reads and writes are local and synchronous; confirmation happens in
  the background with explicit reconciliation; no click path shows a spinner.
- **One UI package.** The desktop app and the web UI share the same UI code.
  App-only features live in a separate capability layer, and a guard refuses
  duplicated UI code.
