# Awareness signals

The signal library of the codebase-awareness engine. Each signal is a pure
function over the parsed files plus its context, returning signal values the
awareness engine aggregates and exposes. The library spans the conventional
signals (complexity, clones, health, architecture, dependencies) and the
experiment-derived mathematical signals (topology, information theory,
physics, network centrality, and the rest), each named after the technique
it computes.

## How it is organized

Each file computes one signal family and is named for it; the header of the
file records the technique and the experiment that motivates it. The shared
`clone-graph.ts` builder backs the clone-based signals. The engine
(`../engine.ts`) discovers and runs them through the registry in
`../config.ts`; no signal is invoked by name from a call site.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/awareness/signals/`.

- `ag-spectrum.ts` is consumed by `engine/src/awareness/engine.ts`.
- `architecture.ts` is consumed by `engine/src/awareness/engine.ts`, `engine/src/awareness/signals/hub-stress.ts`, `engine/src/awareness/signals/ricci-curvature.ts`.
- `banach-contraction.ts` is consumed by `engine/src/awareness/engine.ts`.
- `bell-clones.ts` is consumed by `engine/src/awareness/engine.ts`.
- `benford.ts` is consumed by `engine/src/awareness/engine.ts`.
- `chromatic-number.ts` is consumed by `engine/src/awareness/engine.ts`.
- `clone-graph.ts` is consumed by `engine/src/awareness/signals/ag-spectrum.ts`, `engine/src/awareness/signals/banach-contraction.ts`, `engine/src/awareness/signals/bell-clones.ts`, `engine/src/awareness/signals/chromatic-number.ts`, `engine/src/awareness/signals/homology.ts`, `engine/src/awareness/signals/mechanism-design.ts` and 1 more.
- `clones.ts` is consumed by `engine/src/awareness/engine.ts`.
- `code-metrics.ts` is consumed by `engine/src/awareness/engine.ts`.
- `combinatorics.ts` is consumed by `engine/src/awareness/engine.ts`.
- `complexity.ts` is consumed by `engine/src/awareness/engine.ts`.
- `debt.ts` is consumed by `engine/src/awareness/engine.ts`.
- `dependencies.ts` is consumed by `engine/src/awareness/engine.ts`.
- `diversity.ts` is consumed by `engine/src/awareness/engine.ts`.
- `drift.ts` is consumed by `engine/src/awareness/engine.ts`.
- `edit-predictability.ts` is consumed by `engine/src/awareness/engine.ts`.
- `entropy.ts` is consumed by `engine/src/awareness/engine.ts`.
- `ergodic-drift.ts` is consumed by `engine/src/awareness/engine.ts`.
- `fiber-bundle.ts` is consumed by `engine/src/awareness/engine.ts`.
- `fiedler-bisection.ts` is consumed by `engine/src/awareness/engine.ts`.
- `fitness.ts` is consumed by `engine/src/awareness/engine.ts`.
- `free-probability.ts` is consumed by `engine/src/awareness/engine.ts`.
- `function-classification.ts` is consumed by `engine/src/awareness/engine.ts`.
- `function-stats.ts` is consumed by `engine/src/awareness/engine.ts`.
- `health.ts` is consumed by `engine/src/awareness/engine.ts`.
- `homology.ts` is consumed by `engine/src/awareness/engine.ts`.
- `hotspots.ts` is consumed by `engine/src/awareness/engine.ts`.
- `hub-stress.ts` is consumed by `engine/src/awareness/engine.ts`.
- `info-theory.ts` is consumed by `engine/src/awareness/engine.ts`.
- `linguistic-typology.ts` is consumed by `engine/src/awareness/engine.ts`.
- `martingale-debt.ts` is consumed by `engine/src/awareness/engine.ts`.
- `maxwell-demon.ts` is consumed by `engine/src/awareness/engine.ts`.
- `mechanism-design.ts` is consumed by `engine/src/awareness/engine.ts`.
- `module-roles.ts` is consumed by `engine/src/awareness/engine.ts`.
- `network.ts` is consumed by `engine/src/awareness/engine.ts`.
- `persistence-landscapes.ts` is consumed by `engine/src/awareness/engine.ts`.
- `physics.ts` is consumed by `engine/src/awareness/engine.ts`.
- `qec-distance.ts` is consumed by `engine/src/awareness/engine.ts`.
- `quality.ts` is consumed by `engine/src/awareness/engine.ts`.
- `quantum-stability.ts` is consumed by `engine/src/awareness/engine.ts`.
- `recursion-hierarchy.ts` is consumed by `engine/src/awareness/engine.ts`.
- `ricci-curvature.ts` is consumed by `engine/src/awareness/engine.ts`.
- `risk.ts` is consumed by `engine/src/awareness/engine.ts`.
- `shape-dna.ts` is consumed by `engine/src/awareness/engine.ts`.
- `sheaf-cohomology.ts` is consumed by `engine/src/awareness/engine.ts`.
- `test-coverage.ts` is consumed by `engine/src/awareness/engine.ts`.
- `thermodynamics.ts` is consumed by `engine/src/awareness/engine.ts`.
- `topos.ts` is consumed by `engine/src/awareness/engine.ts`.
- `trending.ts` is consumed by `engine/src/awareness/engine.ts`.
- `turing-treadmills.ts` is consumed by `engine/src/awareness/engine.ts`.
- `type-level.ts` is consumed by `engine/src/awareness/engine.ts`.
- `wavelet-clones.ts` is consumed by `engine/src/awareness/engine.ts`.

<!-- /consumers:generated -->
