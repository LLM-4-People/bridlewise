---
id: UD-S15
date: 2026-10-01
by: user
group: scale
status: in-force
implementation: done
acted_in: [server/db/conversation-archive.ts, scripts/db-archive.ts, server/db/client.ts, engine/src/filesystem/database-provenance.ts]
---
# The fixture chats leave the real database, archived first

A test wrote 204 fixture chats of 1,000 messages each into the real
`web.db`. Approved: fix the leaking test first, then ARCHIVE (export to a
file, proven row by row) and REMOVE them from the live database. This is
the ONE exception to "the conversation record is never removed": only
trashed conversations, only after a verified archive and a verified
pre-archive copy, only from the shell with the server stopped, all or none
(`npm run db-archive`, the action `database.conversations.archive`). Any
other removal needs a decision of its own.
