# Intelligence

The intelligence domain: the repository map, dependency graph, symbol search, and retrieval the model's code questions are answered from.

## What each file does

- `action-affinity-config.ts` — Canonical configuration owner for the action-affinity re-ranker.
- `action-affinity.ts` — the action-affinity module.
- `data-flow.ts` — the data-flow module.
- `dependency-graph.ts` — the dependency-graph module.
- `retrieval.ts` — the codebase-file retrieval module.
- `farm-child.ts` — Crash-isolated extract child (init tree-sitter at spawn).
- `js-tokenizer.ts` — the JS/TS tokenizer (`tokenizeWithPositions`, `Token`): identifiers, punctuation, string and template literals (a `${…}` substitution skipped whole, its own strings and templates included), numbers and regex literals (a `/` opens one after an operator, `=>`, a keyword expecting an operand or a statement head's `)`) with their positions, comments dropped. Read by the symbol extractor, the data-flow and TypeScript quality-pack analyses, and the reachability walk (`src/workflow/reachability.ts`: a specifier in a comment or another string is never an edge); kept apart so a consumer that needs tokens loads no tree-sitter.
- `file-slice.ts` — the file-slice module.
- `intelligence-config.ts` — Intelligence operational defaults — the SINGLE canonical owner for.
- `intelligence-types.ts` — the intelligence-types module.
- `language-registry.ts` — Canonical multi-language registry — ONE source of truth for the.
- `multi-import-extractor.ts` — Multi-language import extractor — regex-based dependency detection for.
- `next-edit-prefetch.ts` — the next-edit-prefetch module.
- `process-farm.ts` — Crash-isolated child-process farm for parse/extract.
- `quick-view.ts` — the quick-view module.
- `repository-map.ts` — the repository-map module.
- `reuse-discovery.ts` — the reuse-discovery module.
- `symbol-extractor.ts` — the symbol-extractor module.
- `symbol-search.ts` — the symbol-search module.
- `tree-sitter-backend.ts` — Tree-sitter WASM backend — async-init, sync-parse.
- `tree-sitter-extractor.ts` — Tree-sitter-backed symbol extractor for non-JS/TS languages.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/intelligence/`.

- `action-affinity-config.ts` is consumed by `engine/src/intelligence/action-affinity.ts`.
- `action-affinity.ts` is consumed by `engine/src/intelligence/symbol-search.ts`.
- `data-flow.ts` is consumed by nothing yet.
- `dependency-graph.ts` is consumed by `engine/src/intelligence/retrieval.ts`, `engine/src/runtime/intelligence-tools.ts`, `server/intelligence/intelligence-bridge.ts`.
- `farm-child.ts` is consumed by nothing yet.
- `file-slice.ts` is consumed by `engine/src/runtime/tool-registry.ts`, `server/intelligence/intelligence-bridge.ts`.
- `intelligence-config.ts` is consumed by `engine/src/intelligence/data-flow.ts`, `engine/src/intelligence/dependency-graph.ts`, `engine/src/intelligence/farm-child.ts`, `engine/src/intelligence/file-slice.ts`, `engine/src/intelligence/intelligence-types.ts`, `engine/src/intelligence/next-edit-prefetch.ts` and 10 more.
- `intelligence-types.ts` is consumed by `engine/src/evaluation/scenarios.ts`, `engine/src/intelligence/action-affinity.ts`, `engine/src/intelligence/data-flow.ts`, `engine/src/intelligence/dependency-graph.ts`, `engine/src/intelligence/multi-import-extractor.ts`, `engine/src/intelligence/next-edit-prefetch.ts` and 11 more.
- `js-tokenizer.ts` is consumed by `engine/src/intelligence/data-flow.ts`, `engine/src/intelligence/symbol-extractor.ts`, `engine/src/quality-packs/typescript-pack.ts`, `engine/src/workflow/reachability.ts`.
- `language-registry.ts` is consumed by `engine/src/editor/syntax-validator.ts`, `engine/src/intelligence/dependency-graph.ts`, `engine/src/intelligence/farm-child.ts`, `engine/src/intelligence/intelligence-types.ts`, `engine/src/intelligence/multi-import-extractor.ts`, `engine/src/intelligence/repository-map.ts` and 4 more.
- `multi-import-extractor.ts` is consumed by `engine/src/intelligence/tree-sitter-extractor.ts`.
- `next-edit-prefetch.ts` is consumed by nothing yet.
- `process-farm.ts` is consumed by `engine/src/intelligence/repository-map.ts`.
- `quick-view.ts` is consumed by `engine/src/runtime/tool-registry.ts`, `server/intelligence/intelligence-bridge.ts`, `server/intelligence/quick-view-worker.ts`.
- `repository-map.ts` is consumed by `engine/src/runtime/intelligence-tools.ts`, `engine/src/runtime/quality-tools.ts`, `server/intelligence/repository-map-worker.ts`.
- `repository-stat-scan.ts` is consumed by `engine/src/intelligence/repository-map.ts`, `engine/src/runtime/intelligence-tools.ts`, `server/intelligence/intelligence-bridge.ts`, `server/intelligence/repository-map-worker.ts`.
- `retrieval.ts` is consumed by `engine/src/kernel/config-contracts.ts`, `server/intelligence/intelligence-bridge.ts`, `server/kernel/harness-config.ts`.
- `reuse-discovery.ts` is consumed by `engine/src/runtime/intelligence-tools.ts`, `server/intelligence/intelligence-bridge.ts`.
- `symbol-extractor.ts` is consumed by `engine/src/intelligence/farm-child.ts`, `engine/src/intelligence/repository-map.ts`, `engine/src/intelligence/repository-stat-scan.ts`, `engine/src/intelligence/tree-sitter-extractor.ts`, `engine/src/performance/function-manifest.ts`, `engine/src/quality-packs/typescript-pack.ts`.
- `symbol-search.ts` is consumed by `engine/src/intelligence/data-flow.ts`, `engine/src/intelligence/retrieval.ts`, `engine/src/intelligence/reuse-discovery.ts`, `engine/src/runtime/intelligence-tools.ts`, `server/intelligence/intelligence-bridge.ts`, `server/kernel/harness-config.ts`.
- `tree-sitter-backend.ts` is consumed by `engine/src/editor/syntax-validator.ts`, `engine/src/intelligence/farm-child.ts`, `engine/src/intelligence/repository-map.ts`, `engine/src/intelligence/tree-sitter-extractor.ts`, `engine/src/performance/function-manifest.ts`, `engine/src/quality-packs/typescript-pack.ts`.
- `tree-sitter-extractor.ts` is consumed by `engine/src/intelligence/symbol-extractor.ts`.

<!-- /consumers:generated -->
