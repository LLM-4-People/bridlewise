# Modules

The container for the engine's self-describing subsystems — each subfolder is one module with its own domain/application layers. The floor applies one level down, not here.

## What each file does

This folder holds no source files of its own; its modules live one level down:

- `effect-boundary/` — the exact-write-lease authority stage.
- `tasks-agents/` — the handoff/assignment protocol subsystem.

## Where it lives and what consumes it

The modules are documented in their own READMEs:

- `effect-boundary/README.md`
- `tasks-agents/README.md`
