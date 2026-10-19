---
id: BL-U1
date: 2026-10-01
by: user
group: labs
status: in-force
implementation: pending
route: BL-R3
---
# The app, the docs and the server are separate packages

Three separately named, built and versioned deliverables in ONE
repository, with one-way dependencies: `bridlewise-app` is the optional
Rust + CEF desktop app (its host, connection editor, browser controller and
device client); `bridlewise-docs` is the docs-writer's documentation
product; the server keeps its packages (`bridlewise-web` with the
`bridlewise` engine), so its frozen encryption salts are untouched. Neither
the app nor the server bundles or imports the docs. This holds for the lab
and for the harness transfer. Refines
[UR-04](UR-04-shared-and-reusable-backend-and-frontend.md): the app consumes
the shared contracts, never copies of them.
