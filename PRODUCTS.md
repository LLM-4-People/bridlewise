# Products and surfaces

Bridlewise is one harness split across two public repositories. This page lists what actually ships, where it lives, and how mature it is. "Shipped" means the code is in the product tree; it does **not** mean production-ready.

Status vocabulary:

- **Developer preview** — runs, is exercised, and can change without migration promises.
- **Pre-admission** — implemented, but the engine's governance gate has not admitted the capability; `harnessReady` is `false`.
- **Linux-only** — the code path depends on Linux Landlock.
- **Draft** — documentation or content that has not been published as final.
- **Active development** — lives in the testing repository and changes continuously.

## Product repository — `bridlewise`

| Surface | Path | What it is | Status |
|---|---|---|---|
| **Cockpit** | `src/cockpit/` | The Svelte 5 run surface: FLOW, SWEEP, DESK, HORIZON, and the summoned rooms (Switch, Custody, Instruments, Settings, Editor). Renders typed beats and exposes their verbs. | Developer preview |
| **Client data layer** | `src/data/`, `src/state/` | Broker, ledger, connection, absence handling, and the nanostores that hold reactive UI state. | Developer preview |
| **Server** | `server/` | The loopback HTTP+SSE trust boundary: auth, sessions, CSRF, rate limits, routing, runs, tool dispatch, providers, redaction, SQLite. | Developer preview; not audited |
| **Engine** | `engine/` | Provider-neutral harness core: agents, tools, transactional editor, code intelligence, quality, memory, privacy, safety, timeline, forensics, MCP. | Pre-admission; interactive capabilities gated |
| **Guardian** | `engine/guardian/` | Frozen C binary that applies a Linux Landlock ruleset and execs the payload; also the process supervisor. | Implemented; Linux-only; requires a native build |
| **Shared contracts** | `shared/` | Routes, types, input schemas, UI schema, error codes, and block/module declarations imported by both sides. | Implemented; the wire contract owner |
| **Lifecycle scripts** | `scripts/` | `sd.mjs` start/stop/restart/status, dev orchestration, database-key operations, and correctness probes. | Implemented for development |
| **Static shell** | `public/` | PWA manifest, service worker, and icons served at the origin root. | Implemented |
| **Git hooks** | development-floor `.githooks/` | The commit/reference hooks used by the development floor. The public product snapshot uses GitHub Actions for its gates. | Development-floor tooling |
| **Documentation site** | `docs/` | This Jekyll site: landing copy, quickstart, architecture, security, design, roadmap, FAQ, CLI, testing, and shipping pages. | Developer preview; published via GitHub Pages |
| **Root README** | `README.md` | The product map: what the system is, how the parts fit, and where each concern lives. | Current for the preview |

## Development floor — `bridlewise-testing`

The testing repository is not a second product. It is where the product is tested, measured, and decided.

| Surface | Path (in `bridlewise-testing`) | What it is | Status |
|---|---|---|---|
| **Prevention suite** | `tests/prevention/` | Mechanical guards for invariants and failure classes: routing, ownership, tokens, decisions, docs liveness, and more. | Active development |
| **Test suites** | `tests/`, `engine/test/` | Unit, integration, live, and end-to-end coverage for the product and engine. | Active development |
| **Benchmarks** | `bench/`, `engine/src/performance/` | Performance and scale measurement, including the large-codebase corpus path. | Active development; corpus fetched separately |
| **Design records** | `docs/design/` | The cockpit redesign, audits, cutover plans, and performance diagnosis. | Curated record |
| **Decision log** | `docs/decisions/` | One file per decision in force, indexed and checked; cited by id across the project. | Generated index, checked |
| **Contribution guide** | `CONTRIBUTING.md`, `docs/testing.md` | Setup, test layers, evidence expectations, and the PR workflow. | Current for contributors |
| **Verification tooling** | `engine/scripts/verification/`, `traceability/` | Hash bindings, requirement registry, traceability projections, and the checks that compare them. | Active development |
| **Promotion profiles** | `promotion/` | Maintainer projection metadata from the development floor to the product tree. Not a public release process. | Development-floor tooling |

## Not shipped

There is no hosted service, no cloud execution, no desktop app, no IDE extension, no installer, no container image, and no signed binary. The product is a source checkout you run locally. If a page or a person offers a hosted Bridlewise account or a binary release today, it is not from this project.

## Repository links

- [`bridlewise`](https://github.com/LLM-4-People/bridlewise) — product, branch `main`.
- [`bridlewise-testing`](https://github.com/LLM-4-People/bridlewise-testing) — development floor, branch `main`.

The public product tree is a sanitized, curated projection of the development floor. The private promotion tooling builds and certifies the full tree; it is not part of the public release process. See [Architecture](docs/architecture.md#shipping) and [Contributing](CONTRIBUTING.md).
