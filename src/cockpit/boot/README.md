# Boot

The cockpit boot surface: registration and sign-in as one continuous flow, with every probe a real measurement.

## What each file does

- `probes.ts` — REGISTRATION probe orchestration — every line is a real measurement.
- `Registration.svelte` — REGISTRATION — boot and sign-in as one continuous control.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `src/cockpit/boot/`.

- `probes.ts` is consumed by `src/cockpit/Cockpit.svelte`, `src/cockpit/boot/Registration.svelte`.

<!-- /consumers:generated -->
