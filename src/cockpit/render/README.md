# Render

The cockpit render layer: markdown, JSON, diffs, code, and artifacts rendered as plain nodes — never raw HTML, never `{@html}` — so recorded model output is untrusted by construction.

## What each file does

- `artifact-errors.ts` — THE ARTIFACT RUNTIME ERROR CHANNEL.
- `artifact.ts` — COCKPIT RENDER — the artifact decision.
- `diff.ts` — COCKPIT RENDER — unified diff → structure (pure).
- `highlight.ts` — COCKPIT RENDER — syntax highlighting as TOKENS.
- `html-preview.ts` — HTML-in-iframe preview security — the single owner.
- The markdown parser is the ONE shared parser, `shared/markdown.ts` (markdown → a tree of plain nodes; the repository's link checks parse with it too).
- `render-config.ts` — COCKPIT RENDER — the render layer's tunable numbers.
- `shapes.ts` — COCKPIT RENDER — what shape is this tool's recorded output.
- `ArtifactFrame.svelte` — THE COCKPIT'S ARTIFACT RENDERER.
- `CodeBlock.svelte` — A named code block.
- `CopyButton.svelte` — The copy affordance, public: the per-block copy inside the render layer, and the one surface other cockpit components (the run pane's trace id) mount for a copyable value. Its `text` prop interpolates as a text node — it renders trusted chrome, never untrusted content.
- `JsonNode.svelte` — One node of a collapsible JSON tree (recursive).
- `JsonView.svelte` — The render layer's public door for one JSON value.
- `MdBlocks.svelte` — Block-level markdown → DOM (recursive).
- `MdInline.svelte` — Inline markdown nodes → DOM (recursive).
- `Prose.svelte` — THE prose renderer for the cockpit.
- `StreamText.svelte` — Plain stream text with its bare URLs walkable.
- `ToolInput.svelte` — Recorded input, rendered as an invocation.
- `ToolOutput.svelte` — Recorded output, rendered in the shape the data actually has.
- `UnifiedDiff.svelte` — THE ONE diff renderer — the flow's micro-diff.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `src/cockpit/render/`.

- `artifact-errors.ts` is consumed by `src/cockpit/render/ArtifactFrame.svelte`.
- `artifact.ts` is consumed by `src/cockpit/flow/ToolBeat.svelte`, `src/cockpit/render/ArtifactFrame.svelte`.
- `diff.ts` is consumed by `src/cockpit/editor/FilePane.svelte`, `src/cockpit/flow/EffectBeat.svelte`, `src/cockpit/render/ToolInput.svelte`, `src/cockpit/render/UnifiedDiff.svelte`, `src/cockpit/rooms/DiffSheet.svelte`.
- `highlight.ts` is consumed by `src/cockpit/render/CodeBlock.svelte`, `src/cockpit/render/ToolInput.svelte`, `src/cockpit/render/UnifiedDiff.svelte`, `src/cockpit/render/diff.ts`, `src/cockpit/render/shapes.ts`.
- `html-preview.ts` is consumed by `src/cockpit/render/ArtifactFrame.svelte`, `src/cockpit/render/artifact-errors.ts`.
- `render-config.ts` is consumed by `src/cockpit/flow/ActBeat.svelte`, `src/cockpit/flow/Beat.svelte`, `src/cockpit/flow/EffectBeat.svelte`, `src/cockpit/flow/RunPane.svelte`, `src/cockpit/flow/StreamPulse.svelte`, `src/cockpit/flow/ThinkingFold.svelte` and 10 more.
- `shapes.ts` is consumed by `src/cockpit/desk/ItemBody.svelte`, `src/cockpit/flow/ActBeat.svelte`, `src/cockpit/flow/Beat.svelte`, `src/cockpit/flow/ToolBeat.svelte`, `src/cockpit/render/CodeBlock.svelte`, `src/cockpit/render/JsonNode.svelte` and 3 more.

<!-- /consumers:generated -->
