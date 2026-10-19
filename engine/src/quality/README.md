# Quality

The quality domain: the quality indicators and checks computed over a codebase.

## What each file does

- `aggregator.ts` — Aggregator + runner (EXP368, refactored for async tree-sitter parsers).
- `base.ts` — Multi-language quality pack — base types (EXP357).
- `config.ts` — Multi-language quality pack — central config (EXP357).
- `index.ts` — Public API for the multi-language quality pack (EXP368 / EXP386).
- `monitoring.ts` — Real-time quality monitoring (EXP386).
- `scoring.ts` — Quality scoring (EXP386, refactored EXP462).
- `signals.ts` — Multi-language signals (EXP357).

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/quality/`.

- `aggregator.ts` is consumed by `engine/src/quality/index.ts`.
- `base.ts` is consumed by `engine/src/quality/aggregator.ts`, `engine/src/quality/checks/barrel-detection.ts`, `engine/src/quality/checks/circular-deps.ts`, `engine/src/quality/checks/code-health-aggregate.ts`, `engine/src/quality/checks/code-health.ts`, `engine/src/quality/checks/complex-condition.ts` and 53 more.
- `config.ts` is consumed by `engine/src/quality/index.ts`, `engine/src/quality/languages/index.ts`.
- `index.ts` is consumed by `engine/src/aux/index.ts`.
- `monitoring.ts` is consumed by `engine/src/quality/index.ts`.
- `scoring.ts` is consumed by `engine/src/quality/index.ts`, `engine/src/quality/monitoring.ts`.
- `signals.ts` is consumed by `engine/src/quality/aggregator.ts`.

<!-- /consumers:generated -->
