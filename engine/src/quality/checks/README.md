# Quality checks

The individual quality checks the multi-language quality pack runs over
parsed files. Each check is one module named for what it flags — dead code,
dead exports, duplicate bodies, complexity, security hotspots, the ESLint
parity checks (`no-*`, `prefer-const`), and the rest. A check consumes the
parsed AST and emits findings; the aggregator runs them all.

## How it is organized

Every check is its own file, discovered by the aggregator rather than named
at a call site, so adding a check is adding a file. The shared machinery is
in `shared.ts` (the DRY extraction of the common helpers) and
`shared-helpers.ts`; the language-agnostic checks operate on the parsed
file model from `../base.ts`, and the per-language parsing lives under
`../languages/`.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/quality/checks/`.

- `barrel-detection.ts` is consumed by `engine/src/quality/checks/dead-code.ts`, `engine/src/quality/checks/dead-exports.ts`.
- `circular-deps.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `code-health-aggregate.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `code-health.ts` is consumed by `engine/src/quality/aggregator.ts`, `engine/src/quality/checks/code-health-aggregate.ts`.
- `complex-condition.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `complexity.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `dead-code.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `dead-exports.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `duplicate-imports.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `duplicate-strings.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `duplicates.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `empty-function.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `long-line.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `long-params.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `no-cond-assign.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `no-constant-condition.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `no-control-regex.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `no-dupe-args.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `no-dupe-class-members.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `no-dupe-keys.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `no-empty.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `no-eval.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `no-extra-boolean-cast.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `no-extra-semi.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `no-fallthrough.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `no-implied-eval.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `no-inner-declarations.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `no-irregular-whitespace.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `no-loss-of-precision.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `no-throw-literal.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `no-unreachable-code.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `no-unsafe-finally.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `no-unsafe-optional-chaining.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `no-unused-expressions.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `no-unused-labels.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `no-var.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `parse-errors.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `performance-anti-pattern.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `prefer-const.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `race-condition.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `security-hotspot.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `shadowed-declaration.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `shared-helpers.ts` is consumed by `engine/src/quality/checks/code-health.ts`, `engine/src/quality/checks/dead-code.ts`, `engine/src/quality/checks/performance-anti-pattern.ts`, `engine/src/quality/checks/race-condition.ts`, `engine/src/quality/checks/shadowed-declaration.ts`.
- `shared.ts` is consumed by `engine/src/quality/checks/no-cond-assign.ts`, `engine/src/quality/checks/no-constant-condition.ts`, `engine/src/quality/checks/no-control-regex.ts`, `engine/src/quality/checks/no-dupe-args.ts`, `engine/src/quality/checks/no-dupe-class-members.ts`, `engine/src/quality/checks/no-dupe-keys.ts` and 19 more.
- `unnecessary-type-assertion.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `unreachable-catch.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `unused-imports.ts` is consumed by `engine/src/quality/aggregator.ts`.
- `unused-type-parameter.ts` is consumed by `engine/src/quality/aggregator.ts`.

<!-- /consumers:generated -->
