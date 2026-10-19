# Flow

The cockpit flow: the full-bleed causal block stream — beats, seams, and the run's live data projected as a stream the reader navigates, not a log they scroll.

Run ownership lasts until an actual transport ending. Output finishing can mark the band ending while the EventSource remains parkable through tool gaps and the epilogue. Run starts capture their workspace before awaiting the server; a late response or older terminal cannot overwrite the foreground band or wait state. The client stream owner scopes screen writes and callbacks, while session-wide inspector history retains its original scope.

Per-turn clocks retain their first ending. The stream's replay projection identifies retained model frames, so receipt activity still reaches Sweep while clocks measure only newly produced output. Missing starts remain unmeasured through subsequent deltas; history supplies the saved timing independently of when replay arrives.

## What each file does

- `beat-request.ts` — A BEAT, ASKED FOR FROM OUTSIDE THE FLOW — the one-shot seam the right menu's row paths travel through.
- `beat-state.ts` — COCKPIT FLOW — the beat state vocabulary (one owner).
- `composer-router.ts` — COCKPIT FLOW — composer submission routing.
- `dock.ts` — COCKPIT FLOW — docking findings into the stream.
- `effect-findings.ts` — COCKPIT FLOW — effect-seam findings.
- `elapsed-clock.ts` — THE ELAPSED CLOCK — one timer for wait-row and live tool duration.
- `fisheye.ts` — COCKPIT FLOW — causal fisheye.
- `flow-config.ts` — FLOW (the multi-workspace memory budget).
- `flow-view.ts` — PER-WORKSPACE FLOW VIEW — where each tab was reading.
- `grouping.ts` — COCKPIT FLOW — consecutive tool calls read as one act.
- `heights.ts` — COCKPIT FLOW — the height index.
- `ingest.ts` — COCKPIT FLOW — ingestion: the surviving data layer into the stream.
- `log.ts` — COCKPIT FLOW — the beat log.
- `rewind.ts` — REWIND — the cockpit's one owner for retry / edit & resend.
- `run-ownership.ts` — WHICH WORKSPACE A LIVE RUN BELONGS TO.
- `run-stream.ts` — COCKPIT run stream — one stream, two consumers.
- `thinking-fold.ts` — THE THINKING BLOCK'S OPEN/CLOSED STATE — one owner.
- `turn-timing.ts` — WHEN THE MODEL'S OUTPUT ACTUALLY BEGAN — observed, per model.
- `types.ts` — COCKPIT FLOW — beat model.
- `verbs.ts` — COCKPIT FLOW — verb wiring (no verb, no pixels).
- `wait-stage.ts` — THE WAIT — what is actually known between "send" and the answer.
- `ActBeat.svelte` — An operator intervention, rendered.
- `Bead.svelte` — The BEAD — a beam-colored pulse that travels the rail.
- `Beat.svelte` — The uniform beat anatomy.
- `BeatDepth.svelte` — THE INLINE DEPTH.
- `BeatScope.svelte` — THE SCOPE SHEET for a beat.
- `CheckDeltaBeat.svelte` — A check's state change, rendered.
- `DeskLine.svelte` — The desk-line content — what the FLOW docks into.
- `EffectBeat.svelte` — An effect beat: a file changed.
- `EventBeat.svelte` — An inline event beat: kind glyph + plain sentence.
- `Flow.svelte` — THE FLOW — full-bleed causal block stream.
- `PathChip.svelte` — FILE PATH IS A DOOR, NOT DEAD TEXT.
- `RunPane.svelte` — THE RUN PANE — the conversation's right-side inspector.
- `Seam.svelte` — The turn seam — a full-bleed hairline.
- `StreamPulse.svelte` — THE RAIL — one instrument for the whole of "waiting".
- `ThinkingFold.svelte` — THE THINKING BLOCK — open while the model thinks.
- `ToolBeat.svelte` — A tool beat — live elapsed, rail, tokens while in flight.
- `TurnBeat.svelte` — BUBBLE — the web-native shape for a message.
- `Verb.svelte` — The only way an interactive control renders.
- `WaitLine.svelte` — THE WAIT ROW — the element between pressing send and the answer.

The flow's dev harness lives one level down:

- `dev/` — the synthetic flow harness.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `src/cockpit/flow/`.

- `beat-request.ts` is consumed by `src/cockpit/flow/Flow.svelte`, `src/cockpit/flow/RunPane.svelte`.
- `beat-state.ts` is consumed by `src/cockpit/flow/ActBeat.svelte`, `src/cockpit/flow/Beat.svelte`, `src/cockpit/flow/EventBeat.svelte`, `src/cockpit/flow/Flow.svelte`, `src/cockpit/flow/ToolBeat.svelte`, `src/cockpit/flow/grouping.ts`.
- `composer-router.ts` is consumed by `src/cockpit/Cockpit.svelte`, `src/cockpit/flow/DeskLine.svelte`, `src/cockpit/flow/Flow.svelte`, `src/cockpit/flow/dev/DevHarness.svelte`, `src/cockpit/shell/Desk.svelte`.
- `dock.ts` is consumed by `src/cockpit/flow/composer-router.ts`, `src/cockpit/flow/effect-findings.ts`.
- `effect-findings.ts` is consumed by `src/cockpit/flow/Flow.svelte`.
- `elapsed-clock.ts` is consumed by `src/cockpit/flow/StreamPulse.svelte`, `src/cockpit/flow/ToolBeat.svelte`, `src/cockpit/flow/WaitLine.svelte`.
- `fisheye.ts` is consumed by `src/cockpit/flow/Beat.svelte`, `src/cockpit/flow/Flow.svelte`.
- `flow-config.ts` is consumed by `src/cockpit/flow/Flow.svelte`, `src/cockpit/flow/RunPane.svelte`, `src/cockpit/flow/log.ts`, `src/cockpit/flow/rewind.ts`, `src/cockpit/sweep/ArmMenuBody.svelte`.
- `flow-view.ts` is consumed by `src/cockpit/flow/Flow.svelte`, `src/cockpit/flow/run-stream.ts`.
- `grouping.ts` is consumed by `src/cockpit/flow/Beat.svelte`, `src/cockpit/flow/Flow.svelte`.
- `heights.ts` is consumed by `src/cockpit/flow/Flow.svelte`.
- `ingest.ts` is consumed by `src/cockpit/flow/Flow.svelte`, `src/cockpit/flow/dev/DevHarness.svelte`, `src/state/run-pane.ts`.
- `log.ts` is consumed by `src/cockpit/flow/BeatDepth.svelte`, `src/cockpit/flow/BeatScope.svelte`, `src/cockpit/flow/EffectBeat.svelte`, `src/cockpit/flow/Flow.svelte`, `src/cockpit/flow/ToolBeat.svelte`, `src/cockpit/flow/dev/DevHarness.svelte` and 4 more.
- `rewind.ts` is consumed by `src/cockpit/flow/Verb.svelte`, `src/cockpit/flow/composer-router.ts`, `src/cockpit/flow/verbs.ts`.
- `run-ownership.ts` is consumed by `src/cockpit/flow/ingest.ts`, `src/cockpit/flow/run-stream.ts`.
- `run-stream.ts` is consumed by `src/cockpit/flow/composer-router.ts`, `src/cockpit/flow/rewind.ts`.
- `thinking-fold.ts` is consumed by `src/cockpit/flow/Flow.svelte`, `src/cockpit/flow/TurnBeat.svelte`, `src/cockpit/flow/ingest.ts`.
- `turn-timing.ts` is consumed by `src/cockpit/flow/StreamPulse.svelte`, `src/cockpit/flow/ToolBeat.svelte`, `src/cockpit/flow/TurnBeat.svelte`, `src/cockpit/flow/ingest.ts`, `src/cockpit/flow/run-stream.ts`, `src/state/run-pane.ts`.
- `types.ts` is consumed by `src/cockpit/computer/FindingNote.svelte`, `src/cockpit/computer/admission.ts`, `src/cockpit/computer/findings.ts`, `src/cockpit/flow/ActBeat.svelte`, `src/cockpit/flow/Beat.svelte`, `src/cockpit/flow/BeatDepth.svelte` and 24 more.
- `verbs.ts` is consumed by `src/cockpit/flow/Flow.svelte`.
- `wait-stage.ts` is consumed by `src/cockpit/flow/Flow.svelte`, `src/cockpit/flow/RunPane.svelte`, `src/cockpit/flow/StreamPulse.svelte`, `src/cockpit/flow/TurnBeat.svelte`, `src/cockpit/flow/WaitLine.svelte`, `src/cockpit/flow/ingest.ts` and 1 more.

<!-- /consumers:generated -->
