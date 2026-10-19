---
id: D-11
date: 2026-09-27
by: coordinator
group: process
status: in-force
implementation: partial
route: A5-CANDIDATE-RETIRE
acted_in: [engine/src/workflow/workspace-manager.ts, engine/src/workflow/workspace-cli.ts, engine/src/workflow/workspace-registry.ts, engine/src/workflow/checkout-setup.ts, engine/bridlewise.config.json, package.json]
---
# Isolation tooling: one workspace tool

The existing `harness workspace` (with a root npm alias) is fixed and
extended rather than replaced: dependencies with `npm ci`, a registry in the git
common directory, a fast-forward land. Owned-change composition (its general
fixes kept), `seed-experiment.mjs` and the dead `harness integrate` are
deleted. Checkpoint capture/verify/restore stays only until the dirty tree is
adopted, then is deleted. Agent-made candidate clones are deleted once unused;
the Codex evidence directory is kept. Until A5 lands, writers qualify in a
candidate checkout (`engine/scripts/tooling/candidate-checkout.ts`).

Carried out by A5 (2026-09-30): the flow is
[WORKFLOW.md, Isolated workspaces](https://github.com/LLM-4-People/bridlewise/blob/main/CONTRIBUTING.md);
the dirty tree was adopted by the step-6 commit, so the checkpoint is deleted.
Open: the candidate checkout's retirement once the first workspace lands
(A5-CANDIDATE-RETIRE, for the coordinator).
