# Unified memory

The unified memory and context subsystem: the ten combined retrieval and
continuity techniques behind the engine's memory. TF-IDF and embeddings
retrieval, the forgetting curve, deterministic conversation summaries,
drift detection, proactive injection, and trust enforcement all live here,
behind the `index.ts` barrel.

## What each file does

- `index.ts` — the public barrel for the subsystem.
- `unified-memory-store.ts` — the store combining all ten techniques.
- `unified-context-manager.ts` — the context manager: progressive trim plus
  the continuity-preserving summary trim.
- `unified-embeddings.ts` — the embeddings provider (all-MiniLM-L6-v2) with
  the TF-IDF fallback.
- `unified-inverted-index.ts` — the lexical inverted index.
- `unified-config.ts` — the single owner of every threshold, cap, weight,
  and budget for the subsystem.
- `unified-tool-result-store.ts` — the tool-result store with deterministic
  summaries.
- `tokenizer.ts` — the stopword-aware tokenizer shared by the memory and
  context subsystems.
- `conversation-summary.ts` — the deterministic hierarchical conversation
  summary.
- `drift-detector.ts` — the deterministic + LLM-based drift detector.
- `ebbinghaus.ts` — the Ebbinghaus forgetting curve with FSRS-4
  reinforcement.
- `proactive-injector.ts` — the proactive-injection query classifier.
- `trust-enforcer.ts` — the trust-enforcement cascade for ignored memory.
- `cache.ts` — the subsystem cache.
- `content-store.ts` — the append-only file-backed content store.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/memory/unified/`.

- `cache.ts` is consumed by `engine/src/memory/unified/index.ts`, `engine/src/memory/unified/unified-memory-store.ts`, `server/llm/redaction.ts`.
- `content-store.ts` is consumed by `engine/src/memory/unified/index.ts`, `engine/src/memory/unified/unified-memory-store.ts`.
- `conversation-summary.ts` is consumed by `engine/src/memory/unified/index.ts`, `engine/src/memory/unified/unified-context-manager.ts`.
- `drift-detector.ts` is consumed by `engine/src/memory/unified/index.ts`, `engine/src/memory/unified/unified-config.ts`.
- `ebbinghaus.ts` is consumed by `engine/src/memory/unified/index.ts`, `engine/src/memory/unified/unified-config.ts`, `engine/src/memory/unified/unified-memory-store.ts`.
- `index.ts` is consumed by `engine/scripts/exp445/run-exp445.mjs`, `engine/scripts/exp456/run-exp456.mjs`.
- `proactive-injector.ts` is consumed by `engine/src/memory/unified/index.ts`, `engine/src/memory/unified/unified-config.ts`.
- `tokenizer.ts` is consumed by `engine/src/memory/unified/conversation-summary.ts`, `engine/src/memory/unified/drift-detector.ts`, `engine/src/memory/unified/index.ts`, `engine/src/memory/unified/unified-config.ts`, `engine/src/memory/unified/unified-context-manager.ts`, `engine/src/memory/unified/unified-memory-store.ts` and 2 more.
- `trust-enforcer.ts` is consumed by `engine/src/memory/unified/index.ts`, `engine/src/memory/unified/unified-config.ts`.
- `unified-config.ts` is consumed by `engine/src/memory/unified/index.ts`, `engine/src/memory/unified/unified-context-manager.ts`, `engine/src/memory/unified/unified-memory-store.ts`, `server/context/context-bridge.ts`.
- `unified-context-manager.ts` is consumed by `engine/src/index.ts`, `engine/src/memory/unified/index.ts`, `engine/src/runtime/interactive-session.ts`, `engine/src/shared/llm/response-transcript.ts`, `server/context/context-bridge.ts`.
- `unified-embeddings.ts` is consumed by `engine/src/memory/unified/index.ts`, `engine/src/memory/unified/unified-config.ts`, `engine/src/memory/unified/unified-memory-store.ts`.
- `unified-inverted-index.ts` is consumed by `engine/src/memory/unified/index.ts`, `engine/src/memory/unified/unified-memory-store.ts`.
- `unified-memory-store.ts` is consumed by `engine/src/memory/unified/index.ts`.
- `unified-tool-result-store.ts` is consumed by `engine/src/memory/unified/index.ts`, `engine/src/memory/unified/unified-config.ts`, `engine/src/memory/unified/unified-context-manager.ts`, `server/context/context-bridge.ts`, `server/tools/tool-executor.ts`.

<!-- /consumers:generated -->
