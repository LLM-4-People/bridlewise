# Evaluation

The evaluation domain: the audit matrix, requirement registry, and scenario scoring that measure the harness against its contract.

## What each file does

- `budget-calculator.ts` — the budget-calculator module.
- `cli.ts` — the cli module.
- `evaluation-config.ts` — the evaluation-config module.
- `index.ts` — the index module.
- `matrix-executor.ts` — the matrix-executor module.
- `matrix-generator.ts` — the matrix-generator module.
- `results-writer.ts` — the results-writer module.
- `scenario-runner.ts` — the scenario-runner module.
- `scenarios.ts` — the scenarios module.
- `semantic-validators.ts` — the semantic-validators module.
- `types.ts` — the types module.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/evaluation/`.

- `budget-calculator.ts` is consumed by `engine/src/evaluation/cli.ts`, `engine/src/evaluation/index.ts`.
- `cli.ts` is consumed by `engine/src/workflow/harness-commands.ts`.
- `evaluation-config.ts` is consumed by `engine/src/evaluation/budget-calculator.ts`, `engine/src/evaluation/matrix-executor.ts`, `engine/src/evaluation/scenario-runner.ts`, `engine/src/shared/exposure/registrations/harness-commands.ts`.
- `index.ts` is consumed by nothing yet.
- `matrix-executor.ts` is consumed by `engine/src/evaluation/cli.ts`.
- `matrix-generator.ts` is consumed by `engine/src/evaluation/cli.ts`, `engine/src/evaluation/index.ts`.
- `results-writer.ts` is consumed by `engine/src/evaluation/cli.ts`, `engine/src/evaluation/matrix-executor.ts`.
- `scenario-runner.ts` is consumed by `engine/src/evaluation/cli.ts`, `engine/src/evaluation/index.ts`, `engine/src/evaluation/matrix-executor.ts`.
- `scenarios.ts` is consumed by `engine/src/evaluation/cli.ts`, `engine/src/evaluation/index.ts`, `engine/src/evaluation/matrix-generator.ts`.
- `semantic-validators.ts` is consumed by `engine/src/evaluation/cli.ts`, `engine/src/evaluation/index.ts`.
- `types.ts` is consumed by `engine/src/evaluation/budget-calculator.ts`, `engine/src/evaluation/cli.ts`, `engine/src/evaluation/index.ts`, `engine/src/evaluation/matrix-executor.ts`, `engine/src/evaluation/matrix-generator.ts`, `engine/src/evaluation/results-writer.ts` and 3 more.

<!-- /consumers:generated -->
