---
id: UD-S12
date: 2026-10-01
by: user
group: scale
status: in-force
implementation: pending
route: SCALE-2b
---
# New events' chain envelope covers a documents digest

For new events the chain envelope gains `documentsDigest` (a digest over
the event's ordered documents) in a new envelope schema version, so
documents become tamper-evident through the chain; old events verify under
the old version.
