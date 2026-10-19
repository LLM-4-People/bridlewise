# Safety

The safety domain: the pre-dispatch gates, the runtime detectors, and the self-protection floor that bound what a run may do.

## What each file does

- `bandaid-ast-detector.ts` — the bandaid-ast-detector module.
- `bandaid-config.ts` — the bandaid-config module.
- `bandaid-detector.ts` — the bandaid-detector module.
- `bandaid-exposure.ts` — Bandaid-module shared exposure — signals, actions, customizations.
- `bandaid-pattern-learner.ts` — the bandaid-pattern-learner module.
- `bias-config.ts` — the bias-config module.
- `bias-detector.ts` — the bias-detector module.
- `bias-preventer.ts` — the bias-preventer module.
- `deviation-detector.ts` — the deviation-detector module.
- `hallucination-config.ts` — the hallucination-config module.
- `hallucination-detector.ts` — Hallucination detector — 7 layers (EXP354/388, EXP447 adds L7 SEMANTIC).
- `hallucination-semantic.ts` — EXP447 — L7 SEMANTIC hallucination layer (ported + improved from EXP388).
- `index.ts` — Unified safety module barrel — composes the hallucination, bias, and.
- `investigation.ts` — the investigation module.
- `pause-ask.ts` — the pause-ask module.
- `safety-config-section.ts` — the safety config section's owner: the section schema and the posture floors.
- `shared-helpers.ts` — the shared-helpers module.
- `step-skip-detector.ts` — the step-skip-detector module.
- `tool-call-gate.ts` — Pre-dispatch hallucination gate for LLM tool calls (EXP485, ).
- `workaround-detector.ts` — the workaround-detector module.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/safety/`.

- `bandaid-ast-detector.ts` is consumed by `engine/src/safety/bandaid-detector.ts`.
- `bandaid-config.ts` is consumed by `engine/src/safety/bandaid-ast-detector.ts`, `engine/src/safety/bandaid-detector.ts`, `engine/src/safety/bandaid-exposure.ts`, `engine/src/safety/deviation-detector.ts`, `engine/src/safety/index.ts`, `engine/src/safety/investigation.ts` and 6 more.
- `bandaid-detector.ts` is consumed by `engine/src/safety/index.ts`, `engine/src/safety/investigation.ts`, `server/kernel/canonical.ts`.
- `bandaid-exposure.ts` is consumed by nothing yet.
- `bandaid-pattern-learner.ts` is consumed by `engine/src/safety/bandaid-exposure.ts`.
- `bias-config.ts` is consumed by `engine/src/safety/bias-detector.ts`, `engine/src/safety/bias-preventer.ts`, `engine/src/safety/index.ts`.
- `bias-detector.ts` is consumed by `engine/src/safety/bias-preventer.ts`, `engine/src/safety/index.ts`.
- `bias-preventer.ts` is consumed by nothing yet.
- `deviation-detector.ts` is consumed by `engine/src/safety/investigation.ts`, `server/kernel/canonical.ts`.
- `hallucination-config.ts` is consumed by `engine/src/safety/hallucination-detector.ts`, `engine/src/safety/hallucination-semantic.ts`, `engine/src/safety/index.ts`.
- `hallucination-detector.ts` is consumed by `engine/src/editor/edit-resolve.ts`, `engine/src/safety/index.ts`.
- `hallucination-semantic.ts` is consumed by `engine/src/safety/hallucination-detector.ts`.
- `index.ts` is consumed by nothing yet.
- `investigation.ts` is consumed by `engine/src/safety/pause-ask.ts`, `server/kernel/canonical.ts`.
- `pause-ask.ts` is consumed by `server/kernel/canonical.ts`.
- `safety-config-section.ts` is consumed by `engine/src/kernel/config-contracts.ts`, `engine/src/shared/exposure/index.ts`, `server/kernel/canonical.ts`.
- `shared-helpers.ts` is consumed by `engine/src/safety/bandaid-ast-detector.ts`, `engine/src/safety/bandaid-pattern-learner.ts`.
- `step-skip-detector.ts` is consumed by `engine/src/safety/investigation.ts`, `server/kernel/canonical.ts`.
- `tool-call-gate.ts` is consumed by `engine/src/agents/agent-runtime.ts`, `engine/src/runtime/governed-tool-dispatch.ts`, `engine/src/runtime/interactive-session.ts`, `engine/src/safety/safety-config-section.ts`, `engine/src/shared/exposure/registrations/safety.ts`, `server/kernel/canonical.ts`.
- `workaround-detector.ts` is consumed by `engine/src/safety/investigation.ts`, `server/kernel/canonical.ts`.

<!-- /consumers:generated -->
