---
id: U-REASONING
date: 2026-09-28
by: user
group: prompt-cache
status: in-force
implementation: pending
route: RC-38
---
# Provider profiles declare the reasoning replay mode

Encrypted reasoning (`include: reasoning.encrypted_content`) is
OpenAI-specific and does not apply to open-weight providers such as Coral; it is
never a Coral defect. Each provider profile declares its reasoning replay mode:
`encrypted` (request the include, replay the encrypted items), `plain` (replay
reasoning items with plain `reasoning_text` content, when the provider accepts
them as input) or `omit`. The Coral profile uses `plain` or `omit`, per a live
effect check.
