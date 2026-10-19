# Shared exposure system (`src/shared/exposure/`)

ONE shared system for exposing **signals**, **actions**, and
**customizations** off every module. After EXP425, no module writes its
own ad-hoc exposure surface — it registers through this system.

## Why

User directive (Round 30): *"functions to expose must be shared as much
as possible, so whenever we want to expose something off a module, we
just use that or these functions, if we have many, best to have them in
a sub-folder and splitted into multiple files"*. And: *"we want to expose
as many things as possible of **everything**"*.

This module is the single source of truth for exposure. Every module
(search, memory, awareness, editor, quality, safety, learning, context,
tools, hallucination, bias) registers its signals, actions, and
customizations here. Consumers (the CLI, the LLM context injector,
extensions, the test harness) read and execute through one API.

## Layout (split per binding directive)

- `signal.ts` — Signal type + `registerSignal` / `getSignal` / `readSignal`.
- `action.ts` — Action type + `registerAction` / `getAction` / `executeAction`.
- `customization.ts` — Customization type + `registerCustomization` / `getCustomizationValue` / `setCustomizationValue`.
- `registry.ts` — central registry facade (`exposureRegistry`) + `snapshot()`.
- `reporter.ts` — `reportAll()` / `reportSignals()` / `reportActions()` / `reportCustomizations()` / `reportJson()`.
- `index.ts` — public API barrel (single import path).
- `catalog.ts` — the generic exposure catalog: the one registry-storage implementation shared by every primitive.
- `config-binding.ts` — ties an exposure Customization to a path in the config, so a published knob is backed by the config document.
- `contract.ts` — the exposure metadata vocabulary every primitive shares.
- `language.ts` — the customization language guard: served settings words, enforced at the source.
- `module-config-sections.ts` — the config-schema owner for the knobs the exposure modules publish.
- `module.ts` — the module declaration (the category primitive every signal/action/customization carries).

The per-module registrations live in `registrations/`.

## Three primitives

### Signal

A dynamically-computed observable value. Values are always computed by
`value()` — never stored constants.

```ts
registerSignal({
  id: "search.queryCount",
  module: "search",
  name: "Query Count",
  description: "Total number of search queries issued",
  type: "counter",
  unit: "count",
  value: () => queryCounter,
});
const n = readSignal("search.queryCount");
```

### Action

A named, invokable operation. The action owns its effects; a consumer
calling `executeAction(id)` does not need to know the module internals.

```ts
registerAction({
  id: "search.clearCache",
  module: "search",
  name: "Clear Cache",
  description: "Clear the search cache",
  execute: async () => { cache.clear(); return { cleared: true }; },
});
await executeAction("search.clearCache");
```

### Customization

A mutable runtime tunable. `default` is the only stored constant;
`current()` is always dynamic; `set()` writes through to the owning
module's runtime state.

```ts
registerCustomization({
  id: "search.threshold",
  module: "search",
  name: "Search Threshold",
  description: "The BM25 score threshold for instant-seal",
  type: "number",
  default: 0.5,
  min: 0,
  max: 1,
  current: () => currentThreshold,
  set: (v) => { currentThreshold = v; },
});
const t = getCustomizationValue("search.threshold");
setCustomizationValue("search.threshold", 0.7);
```

## Reporting

```ts
import { reportAll, reportJson } from "../shared/exposure/index.ts";
const markdown = reportAll();   // for docs + LLM context injection
const json     = reportJson();   // for tooling
```

## Binding directives

- *"Functions to expose must be shared as much as possible"* — this module.
- *"Whenever we want to expose something off a module, we just use that or these functions"* — `registerSignal`, `registerAction`, `registerCustomization`.
- *"If we have many, best to have them in a sub-folder and splitted into multiple files"* — six files in `src/shared/exposure/`.
- *"Expose as many things as possible of **everything**"* — 100+ signals, 50+ actions, 80+ customizations.
- *"Single source of truth"* — one exposure system, no ad-hoc exposure.
- *"Everything dynamically computed"* — signal values and customization `current()` always call a function.
- *"DRY, KISS, YAGNI"* — three small primitives, one registry, one reporter.
