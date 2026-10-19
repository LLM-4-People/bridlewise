# Forensics

The forensic and offline-evidence cluster: the schemas, encryption, normalization, projection, and state for the forensic record, plus the offline contract identity and transport the record travels over.

## What each file does

- `forensic-contracts.ts` — the forensic-contracts module.
- `forensic-crypto.ts` — the forensic-crypto module.
- `forensic-normalization.ts` — the forensic-normalization module.
- `forensic-projection.ts` — the forensic-projection module.
- `forensic-state.ts` — the forensic-state module.
- `forensic-structural.ts` — the forensic-structural module.
- `offline-contracts.ts` — the offline-contracts module.
- `offline-forensics.ts` — the offline-forensics module.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/forensics/`.

- `forensic-contracts.ts` is consumed by `engine/scripts/tooling/verification/slice-traces.ts`, `engine/scripts/verification/slice-projection-inputs.ts`, `engine/scripts/verification/slice-projections.ts`, `engine/src/forensics/forensic-crypto.ts`, `engine/src/forensics/forensic-normalization.ts`, `engine/src/forensics/forensic-projection.ts` and 3 more.
- `forensic-crypto.ts` is consumed by `engine/scripts/verification/slice-projection-inputs.ts`, `engine/src/forensics/forensic-projection.ts`, `engine/src/forensics/offline-forensics.ts`, `engine/src/timeline/timeline-sealing.ts`.
- `forensic-normalization.ts` is consumed by `engine/scripts/verification/slice-projection-inputs.ts`, `engine/src/forensics/offline-forensics.ts`.
- `forensic-projection.ts` is consumed by `engine/scripts/verification/slice-projection-inputs.ts`, `engine/src/forensics/offline-forensics.ts`.
- `forensic-state.ts` is consumed by `engine/scripts/verification/slice-projection-inputs.ts`, `engine/src/forensics/offline-forensics.ts`.
- `forensic-structural.ts` is consumed by `engine/src/forensics/forensic-crypto.ts`, `engine/src/forensics/forensic-normalization.ts`, `engine/src/forensics/forensic-projection.ts`, `engine/src/forensics/forensic-state.ts`.
- `offline-contracts.ts` is consumed by `engine/scripts/tooling/verification/slice-traces.ts`, `engine/scripts/verification/slice-projections.ts`, `engine/src/kernel/preflight.ts`.
- `offline-forensics.ts` is consumed by `engine/scripts/tooling/verification/slice-traces.ts`, `engine/scripts/verification/slice-projections.ts`, `engine/src/kernel/preflight.ts`, `engine/src/workflow/hash-binding-registry.ts`.

<!-- /consumers:generated -->
