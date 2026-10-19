---
id: UD-C9
date: 2026-09-28
by: user
group: configuration
status: in-force
covers: [PRM-DIR]
implementation: pending
route: PRM-0
---
# Prompts live in a versioned prompt registry

Prompts are not plain code constants. A prompt registry holds every harness
prompt (the system prompt, tool descriptions, the summarizer, evaluators,
sub-agent prompts, the prompt-generator catalog) as versioned schemas like
modules, easily editable, scoped through the shared scope model, and able to
test prompts against each other (variants, experiments, evaluation) wired to
the Coral test-drive and evaluation infrastructure. The design choices are
[UD-P](UD-P-prompt-registry-choices.md).
