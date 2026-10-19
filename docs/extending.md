---
layout: default
title: Building on the harness
description: Add a tool, a block, a provider, an MCP server, or an embedded engine session.
permalink: /extending/
---

# Building on the harness

> [!WARNING]
> The extension surfaces are implemented but pre-admission. They can change without notice, and they are not hardened for sensitive codebases. Read [the security model](https://llm-4-people.github.io/bridlewise/security/) before exposing any extension to a model.

Bridlewise is arranged so a capability is declared once and its projections follow. This page names the owners and the extension points; it is a map, not a promise of API stability.

## The shape

```text
shared/                  wire contracts, routes, errors, UI schema
server/                  loopback API and trust boundary
  blocks/                one declaration → route + schema + client + UI contract
  tools/                 the web executor and tool settings
  llm/                   provider persistence and the redaction choke point
  run/                   run claim, stream, and recording
engine/                  standalone CLI and library
  src/tools/             tool manifest and built-in tools
  src/runtime/           provider adapter, tool registry, sessions
  src/editor/            transactional editor
  src/intelligence/      maps, graphs, symbols, slices
  src/quality/           quality packs
  src/memory/            unified and scale memory
  src/timeline/          append-only, hash-chained ledger
  src/safety/            pre-dispatch and runtime gates
  guardian/              Landlock guardian
```

The server drives the engine through `engine/src/index.ts`. The engine is provider- and transport-neutral; it owns domain behavior, not HTTP or UI.

## Add a block (the server's capability unit)

A block is one backend capability. It declares a read, actions, or both, and the route, validation, client binding, schema entry, and UI descriptor are derived from that declaration.

```ts
// server/blocks/my-feature.ts
import { z } from "zod";
import { defineBlock } from "./define.ts";

export const myFeature = defineBlock({
  id: "my.feature",                 // namespace.name
  title: "My feature",
  description: "One sentence a surface can render.",
  read: {
    params: z.object({ projectId: z.string().uuid() }),
    result: z.object({ value: z.string() }),
    handler: async ({ projectId }, ctx) => ({ value: await load(projectId, ctx) }),
  },
  actions: {
    refresh: {
      title: "Refresh",
      consequence: "Recomputes the value from the current project state.",
      params: z.object({ projectId: z.string().uuid() }),
      handler: async ({ projectId }, ctx) => ({ refreshed: await refresh(projectId, ctx) }),
    },
  },
});
```

The block is mounted by the registry; do not add a parallel route. The read route is `GET /api/b/my.feature`, and the action route is `POST /api/b/my.feature/refresh`. Every block read uses the shared envelope, including causality metadata. The UI descriptor is the contract the cockpit renders; a control without a title and consequence is refused at startup.

Owner: `server/blocks/define.ts`. Contract: `shared/block-contract.ts`.

## Add a tool

Tools are governed by one manifest and one executor. A model-facing tool declares its identity, input/output schemas, capabilities, resource bounds, and adapter.

```ts
// engine/src/tools/my-tool.ts
import { createToolRegistry } from "../runtime/tool-registry.ts";

const registry = createToolRegistry({ repositoryRoot });
registry.register({
  definition: {
    name: "my_tool",
    description: "Reads one bounded value from the project.",
    parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
  },
  handler: (args, context) => readValue(context.repositoryRoot, String(args.key)),
});
```

For a tool that the web executor dispatches, register it through the canonical tool surface in `server/tools/` and the engine manifest in `engine/src/tools/`. Do not add a second execution path. A tool that needs an unconfigured adapter must return a typed blocker; it must not silently fall back.

Owner: `engine/src/tools/tool-manifest.ts`, `engine/src/runtime/tool-registry.ts`, `server/tools/tool-executor.ts`.

## Add a provider

The provider adapter speaks the OpenAI Responses protocol and can fall back to Chat Completions. Provider records and encrypted credentials are stored per user in the web database; the engine adapter is constructed with an explicit provider config and key.

```ts
import { createProviderAdapter } from "bridlewise";

const adapter = createProviderAdapter({
  provider: {
    id: "local",
    baseUrl: "http://127.0.0.1:11434/v1",
    timeoutMs: 120_000,
    retries: { maxRetries: 2, initialBackoffMs: 500, maxBackoffMs: 8_000, backoffMultiplier: 2 },
  },
  apiKey: process.env.LOCAL_PROVIDER_KEY ?? "",
});

for await (const event of adapter.streamChatCompletion(request)) {
  // text, tool-call, usage, or finish event
}
```

The web path never reads a provider key from the environment at runtime. A user saves a provider through Settings; the key is encrypted in the database and resolved at the call site. The redaction owner runs before egress and before display.

Owner: `engine/src/runtime/provider-adapter.ts`, `server/llm/providers.ts`, `server/llm/redaction.ts`.

## Add an MCP server

MCP servers are configured in `engine/bridlewise.config.json` under `tools.mcpServers`. Transports: stdio, Streamable HTTP, and a custom WebSocket transport. stdio servers are confined through Landlock to their own harness home. Tool names are minted as `mcp__<serverId>__<toolName>`.

```json
{
  "tools": {
    "mcpServers": {
      "docs": {
        "url": "https://mcp.example.dev/mcp",
        "enabled": true
      }
    }
  }
}
```

A disabled or unreachable server contributes nothing. Credentials are resolved only from the declared allowlist, never from arbitrary `HARNESS_*` variables. Test the server from Settings; the connection status is recorded.

Owner: `engine/src/mcp/`, `server/integrations/mcp-runtime-bridge.ts`.

## Embed the engine

`engine/src/index.ts` is the public barrel. It exposes the CLI runner, provider adapter, tool registry, interactive session, timeline store and recorder, orchestrator, memory stores, transactional editor, metrics collector, and pinned config loader.

```ts
import {
  createTimelineStore,
  createTimelineRecorder,
  createMemoryStore,
  createTransactionalEditor,
} from "bridlewise";

const store = createTimelineStore({ path: "/var/lib/bridlewise/timeline.db" });
const recorder = createTimelineRecorder({ store });
const memory = createMemoryStore({ path: "/var/lib/bridlewise/memory.db" });
const editor = createTransactionalEditor({ repositoryRoot: "/work/project" });
```

The engine has no HTTP server and no UI. The server owns auth, multi-user scoping, and transport. Keep that boundary.

## Add a quality check or language pack

Quality packs live in `engine/src/quality/` and `engine/src/quality-packs/`. A check declares its id, the languages it applies to, the parser input, the diagnostic shape, and whether it is a hard failure. A language pack declares the grammar and the checks it supports.

Do not add a check that reports a vague "problem". A diagnostic must name the file, the range, the rule, and the evidence. A check that cannot run because a parser or fixture is absent must return a typed refusal.

Owner: `engine/src/quality/`, `engine/src/quality-packs/`.

## Add a test

Public smoke tests live in `tests/public/` and use `node:test`. The development floor has the larger suites; see [Testing](https://llm-4-people.github.io/bridlewise/testing/). A new capability needs:

- a unit test for the declared behavior;
- a prevention test or guard when the capability protects an invariant;
- an integration test when it crosses a persistence, protocol, or process boundary;
- a docs update when it changes a command, route, config key, or user-visible behavior.

## Conventions

- One owner per fact. Reuse the canonical declaration; do not create a parallel registry, route, or manifest.
- Validate at the trust boundary. Reject absolute paths, traversal, symlinks where the policy forbids them, and unknown schema fields.
- Typed refusal over silent fallback. If a prerequisite is absent, say so.
- Record effects. A mutation that is not in the ledger did not happen, as far as the harness is concerned.
- Keep the preview honest. Do not add a capability that looks production-ready when its admission gates are open.

## Where to start

- [CLI reference](https://llm-4-people.github.io/bridlewise/cli/)
- [Testing](https://llm-4-people.github.io/bridlewise/testing/)
- [Architecture](https://llm-4-people.github.io/bridlewise/architecture/)
- [Security model](https://llm-4-people.github.io/bridlewise/security/)
