# Self-improving

The self-improving domain: the analysis that turns recorded performance into improvement suggestions.

## What each file does

- `command-log.ts` — EXP424 — Command Log: the canonical append-only log of every command.
- `config.ts` — EXP424 — Self-improving workflow: canonical configuration authority.
- `generation-evolver.ts` — EXP451 — Artificial-life generation evolver: each generation the genome.
- `index.ts` — EXP424 — Self-improving workflow orchestrator.
- `learner.ts` — EXP424 — Self-improving Learner: the deterministic no-LLM loop that.
- `llm-boundary.ts` — EXP424 — LLM Boundary: the mechanical layer that classifies every piece.
- `mistake-detector.ts` — EXP424 — Mistake Detector: the mechanical layer that inspects every.
- `success-detector.ts` — EXP424 — Success Detector: the mechanical layer that extracts.
- `workflow-improver.ts` — EXP424 — Workflow Improver: the mechanical layer that analyzes the.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/self-improving/`.

- `command-log.ts` is consumed by `engine/src/self-improving/index.ts`, `engine/src/self-improving/learner.ts`, `engine/src/self-improving/mistake-detector.ts`, `engine/src/self-improving/success-detector.ts`, `engine/src/self-improving/workflow-improver.ts`.
- `config.ts` is consumed by `engine/src/self-improving/command-log.ts`, `engine/src/self-improving/generation-evolver.ts`, `engine/src/self-improving/index.ts`, `engine/src/self-improving/learner.ts`, `engine/src/self-improving/llm-boundary.ts`, `engine/src/self-improving/mistake-detector.ts` and 2 more.
- `generation-evolver.ts` is consumed by nothing yet.
- `index.ts` is consumed by nothing yet.
- `learner.ts` is consumed by `engine/src/self-improving/index.ts`.
- `llm-boundary.ts` is consumed by `engine/src/self-improving/index.ts`.
- `mistake-detector.ts` is consumed by `engine/src/self-improving/index.ts`, `engine/src/self-improving/learner.ts`.
- `success-detector.ts` is consumed by `engine/src/self-improving/learner.ts`.
- `workflow-improver.ts` is consumed by `engine/src/self-improving/index.ts`.

<!-- /consumers:generated -->
