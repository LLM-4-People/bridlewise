---
id: UD-MCP-MEMORY
date: 2026-10-07
by: user
group: memory
status: in-force
implementation: pending
route: MEM-6
---
# MCP tool outputs can live in the memory layer

The user's decision of 2026-10-07 (PLAN.md):

- **Saved and recalled per tool.** MCP tool outputs can be saved to and
  retrieved from the memory layer. This is selectable per MCP server and tool,
  as a scoped setting.
- **Screened.** The outputs pass the content guard's screening and labelling
  at memory admission and at recall. Their provenance is the MCP server and
  the tool.
- **Referenced, not copied.** Memory references the ledger's content and never
  copies it ([U-M2](U-M2-forget-is-a-crypto-shred.md)).
