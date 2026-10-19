---
id: UR-13
date: 2026-09-27
by: user
group: user-rules
status: in-force
implementation: pending
route: RC-08
---
# Provider deviations live in a versioned provider profile

The harness speaks the official Responses API, true to spec. Anything a
provider does that the spec does not say (Coral included) is isolated in a
declarative, versioned provider profile, one source of truth per provider:
capabilities, request-shaping deviations, response and stream normalization
adapters applied at the transport/decoder boundary (so everything above sees
spec-true data), cache and pricing policy, and the settings, signals and
functions the provider exposes. Adding a provider means adding one validated
profile; profiles are immutable once loaded and verified before acceptance
(schema validation plus an optional live conformance receipt). RC-08..RC-10
build it.
