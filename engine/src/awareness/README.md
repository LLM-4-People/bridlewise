# Awareness

The awareness domain: the engine that computes a codebase's snapshot — complexity, clones, drift, hotspots, and risk — and the signals derived from it.

## What each file does

- `clone-helpers.ts` — the clone-helpers module.
- `compact.ts` — Compact representation: a 200–500 token block summarizing the.
- `config.ts` — Central configuration for the dynamic codebase awareness engine.
- `delta.ts` — EXP387 — Real-time multi-turn awareness delta.
- `engine.ts` — Dynamic awareness engine — the orchestrator.
- `fisher-ranking.ts` — EXP387 — Fisher information ranking + redundancy removal (EXP324).
- `git-command-runner.ts` — the git-command-runner module.
- `language-helpers.ts` — the language-helpers module.
- `module-helpers.ts` — the module-helpers module.
- `multi-turn.ts` — EXP387 — Multi-turn awareness engine.
- `temperature.ts` — the temperature module.
- `types.ts` — Shared types for the dynamic awareness engine. These are produced by.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/awareness/`.

- `clone-helpers.ts` is consumed by `engine/src/awareness/signals/clone-graph.ts`, `engine/src/awareness/signals/clones.ts`, `engine/src/awareness/signals/wavelet-clones.ts`.
- `compact.ts` is consumed by `engine/src/awareness/engine.ts`.
- `config.ts` is consumed by `engine/scripts/exp446/run-llm-usefulness.mts`, `engine/scripts/exp462/run-llm-usefulness-10x.mts`, `engine/src/aux/index.ts`, `engine/src/awareness/engine.ts`, `engine/src/awareness/languages/index.ts`, `engine/src/awareness/multi-turn.ts` and 3 more.
- `delta.ts` is consumed by `engine/src/awareness/multi-turn.ts`.
- `engine.ts` is consumed by `engine/scripts/exp446/run-llm-usefulness.mts`, `engine/scripts/exp462/run-llm-usefulness-10x.mts`, `engine/src/awareness/multi-turn.ts`, `server/awareness/awareness-worker.ts`.
- `fisher-ranking.ts` is consumed by nothing yet.
- `git-command-runner.ts` is consumed by nothing yet.
- `language-helpers.ts` is consumed by `engine/src/awareness/languages/go-tree-sitter.ts`, `engine/src/awareness/languages/go.ts`, `engine/src/awareness/languages/python-tree-sitter.ts`, `engine/src/awareness/languages/python.ts`, `engine/src/awareness/languages/rust-tree-sitter.ts`, `engine/src/awareness/languages/rust.ts` and 1 more.
- `module-helpers.ts` is consumed by `engine/src/awareness/signals/fiber-bundle.ts`, `engine/src/awareness/signals/maxwell-demon.ts`, `engine/src/awareness/signals/sheaf-cohomology.ts`, `engine/src/awareness/signals/topos.ts`.
- `multi-turn.ts` is consumed by nothing yet.
- `temperature.ts` is consumed by nothing yet.
- `types.ts` is consumed by `engine/src/awareness/compact.ts`, `engine/src/awareness/delta.ts`, `engine/src/awareness/engine.ts`, `engine/src/awareness/fisher-ranking.ts`, `engine/src/awareness/git-command-runner.ts`, `engine/src/awareness/languages/generic.ts` and 64 more.

<!-- /consumers:generated -->
