---
id: UD-AUDIT-ROUTING
date: 2026-10-07
by: user
group: responses
status: in-force
implementation: pending
route: RC-ROUTING
---
# Provider failover is explicit routing

The user's audit decision of 2026-10-07 (PLAN.md, "USER DECISIONS (2026-10-07, audit)"):

- **Automatic failover is deleted.** When a provider fails, the failure shows
  at once with a one-click "retry on <other provider>".
- **Automatic routing exists only as a visible policy** that the user
  configured.
- **`path_credential_store` stays a confinement refusal.** It refuses on the
  location, not on the content.
