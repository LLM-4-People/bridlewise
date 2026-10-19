---
layout: default
title: "Architecture"
description: "How the Bridlewise cockpit, loopback server, engine, guardian, and shared contracts fit together — and where the trust boundary sits."
permalink: /architecture/
---

# Architecture

Bridlewise is a local web application with four moving parts and one shared contract:

- a **Svelte cockpit** in the browser;
- a **loopback HTTP+SSE server** that owns auth, sessions, policy, runs, and storage;
- a **standalone engine** that owns agents, tools, the editor, intelligence, memory, quality, and the timeline ledger;
- a **Landlock guardian** that confines server-spawned shell commands and stdio MCP servers on Linux;
- **shared wire contracts** that both sides import, so routes, schemas, and UI are projected from one declaration.

Nothing in this document is a claim of production readiness. The engine is pre-admission. See [Security and limits]({{ '/security/' | relative_url }}).

## The shape

<figure class="system-figure">
  <img src="{{ '/assets/architecture.svg' | relative_url }}" alt="Bridlewise architecture: the cockpit calls a loopback server over HTTP and SSE; the server owns SQLite and the run and tool executors; the engine owns agents, tools, intelligence, and memory and reaches the project through the Landlock guardian; the engine calls the configured provider; keys live in a key home outside the checkout.">
  <figcaption>The local shape. The provider is the one intentional egress; the key home is outside every checkout.</figcaption>
</figure>

The browser never calls a model provider. It calls the server; the server calls the engine and the provider. The engine does not own auth, sessions, or the HTTP boundary. The guardian does not decide policy; it applies an irrevocable OS restriction to a process tree.

## Components

| Component | Path | Responsibility |
|---|---|---|
| Cockpit | `src/cockpit/` | The run surface: FLOW, SWEEP, DESK, HORIZON, and summoned rooms (Switch, Custody, Instruments, Settings, Editor). Renders typed beats and exposes actions; holds only UI state. |
| Client data layer | `src/data/`, `src/state/` | Broker, ledger, connection, absence handling, and the nanostores that hold reactive state. |
| Server | `server/` | The trust boundary. Auth, sessions, CSRF, rate limits, routing, run lifecycle, tool dispatch, provider wiring, redaction, and SSE. Binds to `127.0.0.1` by default. |
| Engine | `engine/` | Provider-neutral harness core: CLI, agents, tools, transactional editor, code intelligence, quality packs, memory, privacy, safety detectors, timeline, forensics, MCP, and self-protection. |
| Guardian | `engine/guardian/` | A frozen C binary that applies a Linux Landlock ruleset to itself and `execvp`s the payload. The restriction is inherited and irrevocable. |
| Shared contracts | `shared/` | Routes, types, input schemas, UI schema, error codes, and block/module declarations. Declared once; consumed on both sides. |
| Lifecycle scripts | `scripts/` | `sd.mjs` start/stop/restart/status, dev orchestration, database-key operations, probes. |
| Static shell | `public/` | PWA manifest, service worker, icons. |

Each domain folder has its own README. The product root's [README](https://github.com/LLM-4-People/bridlewise#readme) is the map; this page is the shape.

## The life of a run

A **run** is the unit of work. It is not a request handler, and it is not a chat message. It is an execution with an owner, a stream, a claim, and a record.

1. **The cockpit asks to start.** `POST /api/run/start` carries the prompt and, when bound to a conversation, the chat id. It passes through the router's auth, CSRF, and rate-limit gates before a handler sees it.
2. **The provider is resolved first.** The server loads the account's provider store and resolves the requested model (or the stored default). No provider, no model, or no key produces a typed refusal — `provider_not_configured`, `model_not_chosen`, `model_not_configured`, or `provider_key_missing` — before any run id, history load, or persisted message. Nothing is half-created.
3. **The run is claimed exactly once.** The executor's first effect is a primary-key claim on `run_executions.run_id`. A second execution of the same run is refused by the database before a prompt is assembled. This is why opening a second viewer cannot double-bill a provider or dispatch a tool twice.
4. **Context is assembled.** Conversation history, project context, and memory retrieval are combined. The request is deduplicated and, when enabled, compressed at the LLM choke point.
5. **Redaction runs at the egress owner.** Content bound for the provider passes through the single redaction adapter (`server/llm/redaction.ts`), which wraps the canonical privacy engine. Callers cannot opt out by using a different route.
6. **The model streams.** The server sends the request to the configured OpenAI-compatible endpoint and records the stream as typed model events. Fixture mode is explicit (`HARNESS_WEB_LLM_FIXTURES=1`) and marked in the record; a provider failure never silently becomes fixture output.
7. **Tool calls are checked before dispatch.** A pre-dispatch gate rejects ghost tools, schema mismatches, and loops. A rejected call is a typed blocker, not a substitute action.
8. **The tool executes through one executor.** The registry resolves the tool, the executor enforces path and project scope, and the result is recorded. File effects are written through the transactional editor; shell commands run under the project's confinement.
9. **Checks and findings are recorded.** Auto-checks, quality signals, and computed findings become beats with their source and derivation. Runtime detectors can add anomaly or steering events while the turn is still streaming.
10. **Frames are published.** The run publishes frames to a feed. `GET /api/run/:runId/stream` subscribes to that feed and replays from `Last-Event-ID` on reconnect. The stream route imports neither the executor nor the LLM bridge; a GET cannot start a run.
11. **The projection is persisted.** Chats, messages, run status, and the ledger are written to SQLite. The timeline append is separate from the chat projection; a rewind retracts or replaces a prior turn by appending, so the ledger stays append-only.
12. **Only an explicit action stops work.** `POST /api/run/:runId/cancel` cancels; a subscriber disconnecting only unsubscribes. This distinction is deliberate: a closed tab must not destroy another viewer's paid work.

## The trust boundary

The boundary is the loopback server, not the browser tab.

- **Bind address.** The server binds to `127.0.0.1` by default and rejects a request whose `Host` is not loopback with a `403`. The default UI origin is `http://127.0.0.1:5173`; the allowed origin is explicit. Do not override `HARNESS_WEB_HOST` to expose the server; it is a local boundary, not a deployment mode.
- **Authentication.** Passwords are hashed with scrypt and a per-password salt. Sessions are random 32-byte tokens in HttpOnly, SameSite=Lax cookies; the database stores a SHA-256 hash of the token, so a database leak does not hand over live sessions. Login runs the password check even for an unknown user to avoid a timing oracle.
- **CSRF and rate limits.** Enforced at the router choke point, not repeated per route. Mutating requests require the CSRF header; public paths are a short, explicit allowlist.
- **Authorization.** Every route resolves the user context; project, chat, and provider reads are scoped to the owner. Admin-only configuration writes are checked at the route and again at the document writer.
- **Path safety.** Tools execute in the selected project directory. The filesystem layer rejects traversal and symlink escapes; the editor resolves exact targets inside the project.
- **Provider egress.** The configured endpoint is the only model destination. There is no Bridlewise relay or hosted proxy in the request path.
- **The model is untrusted.** Model text and tool arguments are data. Tool calls are validated against schemas before dispatch; artifact HTML is rendered in a sandboxed iframe without same-origin access.
- **The project is untrusted.** Repository content can contain prompt injection. Redaction reduces accidental secret egress; it does not make hostile repository content safe.
- **The local user is inside the boundary.** Anyone who can read your user account, the key home, the database, or the process memory can reach the data. Landlock does not defend against the local user; it limits what the confined process can reach.

## Storage

| Data | Default location | Notes |
|---|---|---|
| Web database | `.bridlewise/web.db` | Override with `HARNESS_WEB_DB_PATH`. Users, sessions, chats, projects, providers, preferences. |
| Timeline ledger | `.bridlewise/timeline.db` | Append-only event ledger with a local SHA-256 chain per record. Queryable by the cockpit. |
| Engine state | `.bridlewise/state` | Declared in `engine/bridlewise.config.json`; receipts and execution evidence. |
| Database key material | Key home | `HARNESS_KEY_HOME`, else `$XDG_CONFIG_HOME/bridlewise/keys`, else `~/.config/bridlewise/keys`. Mode `0700`; never under a checkout or the system temp folder. |
| Dev process records | `.dev/` | PID files and the boot stderr tail, written by `sd.mjs`. Ignored by git. |

Sensitive database columns are encrypted at the application layer with AES-256-GCM. The ciphertext is bound to its table, column, row, parent, and owner through associated data, so a value moved to another row does not decrypt. IDs, timestamps, status, and roles remain plaintext so they stay queryable. **The SQLite file as a whole is not encrypted**; protecting the file still depends on filesystem permissions and full-disk encryption.

Keys are not backups. A copy of the database without the key home is unreadable. Back up the key home separately, and do not commit it.

## The block and exposure pipeline

A capability is declared once in `shared/` as a block or module. The server's schema layer projects that declaration into:

- route registration and input validation;
- the served UI schema;
- the client's typed surface;
- the settings, signals, and actions exposed in the cockpit.

A backend capability reaches the screen by generation rather than by hand-wiring a component per feature. The same principle governs tools: one registry, one manifest endpoint, one executor, one renderer. Adding a tool registers it once; the manifest, execution path, and UI pick it up.

This is an architectural preference with a cost: the projection layer is complex, and a bad declaration can surface in several places at once. It is also why the two sides cannot quietly drift into different route or schema spellings.

## Code intelligence and the editor

Intelligence is served from `engine/src/intelligence/` through `server/intelligence/`. Tree-sitter parses source; the engine builds repository maps, symbol indexes, dependency graphs (including cycles), data-flow views, reuse candidates, and AST-accurate slices. The model asks for a symbol or a dependency edge instead of receiving a grep dump.

The editor is one unified `edit` tool. It supports replace, insert, delete, and create through an exact old-string/new-string match, plans and validates the change, and can roll back. The cockpit renders the resulting diff as an effect beat. There is no autonomous commit: `git_commit` is exposed but returns a governance blocker.

## Confinement

The guardian binary applies a Landlock ruleset to itself and `exec`s a payload. The web server uses it per spawned shell command and per stdio MCP server, confining the process and its descendants to the selected project. The CLI itself is not re-exec'd under the guardian: `preflight`, `quality`, and `harness` run as ordinary Node processes even when self-protection is enabled. A missing binary or kernel feature is a typed refusal; it is not silently skipped.

The guardian confines **filesystem access**. It is not a virtual machine, a container, a network firewall, or a seccomp profile. A confined shell can still reach the network if the process is not otherwise restricted, and the model provider still receives the prompt content you send it. `execute_command` is separately confined to the selected project.

Non-`chat` engine commands (`preflight`, `harness`, `quality`) are development and CI tooling that must read `src/`; even when self-protection is enabled, they run unprotected with a warning. This is a deliberate exception, not a claim that those commands are sandboxed.

## Pre-admission

The engine's governance contract is pinned by `engine/src/kernel/root-policy.ts`. `node src/cli.ts preflight` returns an integrity-only receipt with `harnessReady: false`; each interactive capability (model invocation, tool dispatch, repository mutation, process launch, network use, durable audit) is reported `deny` with a typed reason until the governance gate admits it. The web harness is a developer preview built around that gate.

That state is the reason for the warning at the top of this site. Architecture can describe the intended boundary; it cannot substitute for admission evidence, independent review, or an audit.

## Shipping

Development happens on the `testing` branch of [`bridlewise-testing`](https://github.com/LLM-4-People/bridlewise-testing). The public product tree (`main` of [`bridlewise`](https://github.com/LLM-4-People/bridlewise)) is a projection of the development branch, computed by the promotion tooling, not a hand-edited fork. The promotion builds a candidate tree, runs its gates, commits the exact tree, and fast-forwards the product checkout. The public product tree is a sanitized snapshot; the development floor carries the full test and design record.

For contributors, this has a practical consequence: a change belongs on the testing floor with its tests and evidence, then travels through promotion. The process guide lives in the testing repository.

## What this architecture does not claim

- It does not claim the boundary is complete or audited.
- It does not claim Landlock makes arbitrary code safe.
- It does not claim the timeline is tamper-proof. It is append-only at the application layer with a local hash chain; a local attacker who can rewrite the database can rewrite the chain, and there is no external anchor or signature.
- It does not claim provider compatibility beyond the OpenAI-style protocols implemented here.
- It does not claim the preview is ready for sensitive code.

Those limits are part of the design, not footnotes to hide. Read [Security and limits]({{ '/security/' | relative_url }}) next.
