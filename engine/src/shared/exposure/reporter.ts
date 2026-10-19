/**
 * Shared exposure system — reporter.
 *
 * Generates a comprehensive report of every signal, action, and
 * customization registered in the harness. The report is consumed two
 * ways:
 *
 * 1. **Documentation.** `reportAll` returns a structured Markdown
 * string that lists every exposed thing grouped by module and
 * primitive. It is the canonical "what can I touch?" document for
 * operators and extension authors.
 *
 * 2. **The LLM.** During a conversation, the harness calls
 * `reportAll` (or a filtered variant) and injects it as context
 * so the model knows exactly what signals it can read, actions it
 * can execute, and customizations it can tune — without reading
 * source code.
 *
 * The reporter is read-only: it never mutates the registry.
 */

import { type ExposureContract, isContractSpecified } from "./contract.ts";
import {
  countActions,
  listActions,
  type Action,
} from "./action.ts";
import {
  countCustomizations,
  listCustomizations,
  type Customization,
} from "./customization.ts";
import {
  countSignals,
  listSignals,
  type Signal,
} from "./signal.ts";

/** A flat grouped report entry. */
type ModuleGroup = Readonly<{
  module: string;
  signals: readonly Signal[];
  actions: readonly Action[];
  customizations: readonly Customization[];
}>;

/** Group registered primitives by module. */
function groupByModule(): readonly ModuleGroup[] {
  const modules = new Set<string>();
  for (const signal of listSignals()) modules.add(signal.module);
  for (const action of listActions()) modules.add(action.module);
  for (const customization of listCustomizations()) modules.add(customization.module);
  const groups: ModuleGroup[] = [];
  for (const module of Array.from(modules).sort()) {
    groups.push({
      module,
      signals: listSignals().filter((s) => s.module === module),
      actions: listActions().filter((a) => a.module === module),
      customizations: listCustomizations().filter((c) => c.module === module),
    });
  }
  return groups;
}

/** Render a single signal as a Markdown line. */
function renderSignal(signal: Signal): string {
  const unit = signal.unit ? ` (${signal.unit})` : "";
  return `- **\`${signal.id}\`** — ${signal.name}: ${signal.description} [type: ${signal.type}${unit}]`;
}

/** Render a single action as a Markdown line. */
function renderAction(action: Action): string {
  const argList = action.args
    ? ` — args: ${Object.entries(action.args)
        .map(([n, d]) => `${n}: ${d.type}${d.required ? "?" : "?"}`)
        .join(", ")}`
    : "";
  return `- **\`${action.id}\`** — ${action.name}: ${action.description}${argList}`;
}

/** Render a single customization as a Markdown line. */
function renderCustomization(customization: Customization): string {
  const bounds: string[] = [];
  if (customization.min !== undefined) bounds.push(`min=${customization.min}`);
  if (customization.max !== undefined) bounds.push(`max=${customization.max}`);
  if (customization.enum) bounds.push(`enum=[${customization.enum.join("|")}]`);
  const boundsStr = bounds.length > 0 ? ` [${bounds.join(", ")}]` : "";
  return `- **\`${customization.id}\`** — ${customization.name}: ${customization.description} [type: ${customization.type}, default: \`${JSON.stringify(customization.default)}\`]${boundsStr}`;
}

/** Full Markdown report — every signal, action, and customization. */
export function reportAll(): string {
  const groups = groupByModule();
  const lines: string[] = [];
  lines.push("# Harness Exposure Report");
  lines.push("");
  lines.push(
    `Generated ${new Date().toISOString()} — ${countSignals()} signals, ${countActions()} actions, ${countCustomizations()} customizations (${countSignals() + countActions() + countCustomizations()} total).`,
  );
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Signals: ${countSignals()}`);
  lines.push(`- Actions: ${countActions()}`);
  lines.push(`- Customizations: ${countCustomizations()}`);
  lines.push(`- Total exposed items: ${countSignals() + countActions() + countCustomizations()}`);
  lines.push(`- Modules represented: ${groups.length}`);
  lines.push("");
  for (const group of groups) {
    lines.push(`## Module: \`${group.module}\``);
    lines.push("");
    if (group.signals.length > 0) {
      lines.push(`### Signals (${group.signals.length})`);
      lines.push("");
      for (const signal of group.signals) lines.push(renderSignal(signal));
      lines.push("");
    }
    if (group.actions.length > 0) {
      lines.push(`### Actions (${group.actions.length})`);
      lines.push("");
      for (const action of group.actions) lines.push(renderAction(action));
      lines.push("");
    }
    if (group.customizations.length > 0) {
      lines.push(`### Customizations (${group.customizations.length})`);
      lines.push("");
      for (const customization of group.customizations) {
        lines.push(renderCustomization(customization));
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

/** Report only signals (Markdown). */
export function reportSignals(): string {
  const groups = groupByModule();
  const lines: string[] = [];
  lines.push("# Harness Signals Report");
  lines.push("");
  lines.push(`${countSignals()} signals across ${groups.filter((g) => g.signals.length > 0).length} modules.`);
  lines.push("");
  for (const group of groups) {
    if (group.signals.length === 0) continue;
    lines.push(`## Module: \`${group.module}\` (${group.signals.length})`);
    lines.push("");
    for (const signal of group.signals) lines.push(renderSignal(signal));
    lines.push("");
  }
  return lines.join("\n");
}

/** Report only actions (Markdown). */
export function reportActions(): string {
  const groups = groupByModule();
  const lines: string[] = [];
  lines.push("# Harness Actions Report");
  lines.push("");
  lines.push(`${countActions()} actions across ${groups.filter((g) => g.actions.length > 0).length} modules.`);
  lines.push("");
  for (const group of groups) {
    if (group.actions.length === 0) continue;
    lines.push(`## Module: \`${group.module}\` (${group.actions.length})`);
    lines.push("");
    for (const action of group.actions) lines.push(renderAction(action));
    lines.push("");
  }
  return lines.join("\n");
}

/** Report only customizations (Markdown). */
export function reportCustomizations(): string {
  const groups = groupByModule();
  const lines: string[] = [];
  lines.push("# Harness Customizations Report");
  lines.push("");
  lines.push(
    `${countCustomizations()} customizations across ${groups.filter((g) => g.customizations.length > 0).length} modules.`,
  );
  lines.push("");
  for (const group of groups) {
    if (group.customizations.length === 0) continue;
    lines.push(`## Module: \`${group.module}\` (${group.customizations.length})`);
    lines.push("");
    for (const customization of group.customizations) {
      lines.push(renderCustomization(customization));
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** Compact machine-readable JSON of the entire exposure surface. */
/**
 * How much of the exposure surface has classified its contract metadata,
 * per primitive. `specified` counts entries stating at least one field.
 */
export function contractCoverage(): Readonly<{
  signals: { specified: number; total: number };
  actions: { specified: number; total: number };
  customizations: { specified: number; total: number };
}> {
  const count = (entries: readonly { contract?: ExposureContract }[]) => ({
    specified: entries.filter((e) => isContractSpecified(e.contract)).length,
    total: entries.length,
  });
  return {
    signals: count(listSignals()),
    actions: count(listActions()),
    customizations: count(listCustomizations()),
  };
}

export function reportJson(): string {
  return JSON.stringify(
    {
      signals: listSignals(),
      actions: listActions(),
      customizations: listCustomizations(),
      counts: {
        signals: countSignals(),
        actions: countActions(),
        customizations: countCustomizations(),
        total: countSignals() + countActions() + countCustomizations(),
      },
      // Contract metadata is optional, so its adoption must be VISIBLE rather
      // than assumed. Reporting coverage makes the gap a number someone can
      // act on instead of a silent "unspecified" that reads as classified.
      contractCoverage: contractCoverage(),
    },
    null,
    2,
  );
}
