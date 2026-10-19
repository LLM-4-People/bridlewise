# Response

The response surface: the one element that renders a surface's answer, and the grammar every cockpit surface shares.

## What each file does

- `grammar.ts` — THE RESPONSE GRAMMAR — the one vocabulary every cockpit surface uses.
- `Answer.svelte` — THE ONE ELEMENT that renders a surface's answer.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `src/cockpit/response/`.

- `grammar.ts` is consumed by `src/cockpit/boot/Registration.svelte`, `src/cockpit/boot/probes.ts`, `src/cockpit/desk/BreakerRow.svelte`, `src/cockpit/desk/ChannelScope.svelte`, `src/cockpit/desk/ChannelStrip.svelte`, `src/cockpit/desk/DeskPanel.svelte` and 38 more.

<!-- /consumers:generated -->
