---
id: PROMO-DIR
date: 2026-09-29
by: user
group: promotion
status: in-force
implementation: pending
route: PROMO-0
---
# Promotion is a generic, hands-free primitive

The `testing` to `master` merge becomes as hands-free, forgiving, smart,
resilient and agnostic as possible, in the repository and generic: a
repeatable promotion primitive (any source ref to any target ref through a
declared projection and boundary, idempotent, runnable any number of times,
usable for other pairs such as the docs-lab graduation or other harness
repositories). No one-off scripts, no hard-coded branch names or paths: all
configuration. Its tasks land before the first promotion after the first
committed `testing`.
