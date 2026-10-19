---
id: RC-DIR
date: 2026-09-27
by: user
group: responses
status: in-force
implementation: pending
route: RC
---
# The Responses API everywhere, driven against a real provider

The Chat Completions API is replaced by the Responses API everywhere in the
harness, using as many of the protocol's capabilities as possible, true to
spec, including Coral's cross-session prompt cache reuse. The real harness is
test-driven against Coral with long conversations, multi-turn work and real
tasks on real codebases; the output is evaluated and improved; every
discrepancy in Coral's implementation is recorded (in its provider profile and
its generated report, [UR-13](UR-13-provider-deviations-live-in-a-provider-profile.md)).
Caching never costs a harness function ([UR-03](UR-03-caching-never-sacrifices-a-harness-function.md)).
