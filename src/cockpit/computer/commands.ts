/**
 * COCKPIT COMPUTER — the `/` grammar (spec §5.3).
 *
 * `/` enumerates the BLOCK-ACTION REGISTRY: the palette is GENERATED from
 * the same declarations the server executes — `UiSchema.blockActions`, the
 * per-block `BlockActionDescriptor` manifest derived from the block
 * registry — so it can neither lie nor go stale. Labels and consequence
 * sentences render VERBATIM from the declaration (block-contract law: a
 * surface may not invent, translate or embellish them). Execution goes
 * through `broker.action`, the single client door for block writes, firing
 * the action's declared invalidation events.
 *
 * Deny-by-default on input (the same rule as the module action fabric): an
 * action whose declared param template references the selection bus
 * (`$sel.*`) cannot be built from the composer (no selection lives there),
 * and an action with NO declared template is for bespoke callers — both
 * are LISTED (the registry is the registry) but marked not-runnable with
 * the honest reason, never silently dropped and never sent half-built.
 */

import { uiSchema } from "../../state/schema-store.ts";
import { action as brokerAction } from "../../data/broker.ts";
import type { BlockActionDescriptor } from "../../../shared/block-contract.ts";

export type CommandEntry = Readonly<{
  /** The typed name: `block/action`, e.g. "tools.enabled/toggle". */
  id: string;
  block: string;
  name: string;
  /** Declared plain-language verb — verbatim. */
  label: string;
  /** Declared consequence sentence — verbatim. */
  consequence: string;
  /** Literal input from the declared template, when buildable here. */
  input: Readonly<Record<string, string>> | null;
  /** Why it cannot run from the composer (null = runnable). */
  blockedReason: string | null;
  invalidates: readonly string[];
}>;

function toEntry(block: string, d: BlockActionDescriptor): CommandEntry {
  let input: Readonly<Record<string, string>> | null = null;
  let blockedReason: string | null = null;
  if (d.params === undefined) {
    blockedReason =
      "declares no input template — it runs from its own surface, not the composer";
  } else {
    const selRefs = Object.entries(d.params).filter(([, v]) => v.includes("$sel."));
    if (selRefs.length > 0) {
      blockedReason = `needs a selection (${selRefs.map(([k]) => k).join(", ")}) — select its subject first`;
    } else {
      input = d.params;
    }
  }
  return {
    id: `${block}/${d.name}`,
    block,
    name: d.name,
    label: d.title,
    consequence: d.consequence,
    input,
    blockedReason,
    invalidates: d.invalidates ?? [],
  };
}

/** The live command list — generated from the served manifest on each call. */
export function commandEntries(): readonly CommandEntry[] {
  const manifest = uiSchema.get()?.blockActions;
  if (manifest === undefined) return [];
  const out: CommandEntry[] = [];
  for (const [block, descriptors] of Object.entries(manifest)) {
    for (const d of descriptors) out.push(toEntry(block, d));
  }
  return out;
}

export type CommandMatch = Readonly<{
  entry: CommandEntry;
  score: number;
}>;

/** Subsequence fuzzy match; higher is better; null when no match. */
export function fuzzyMatchScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (q.length === 0) return 0;
  let qi = 0;
  let score = 0;
  let streak = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti += 1) {
    if (t[ti] === q[qi]) {
      qi += 1;
      streak += 1;
      score += streak; // consecutive matches compound
    } else {
      streak = 0;
    }
  }
  if (qi < q.length) return null;
  // Prefer shorter targets and prefix matches.
  if (t.startsWith(q)) score += 20;
  return score - t.length / 100;
}

export function matchCommands(query: string, limit = 8): readonly CommandMatch[] {
  const scored: CommandMatch[] = [];
  for (const entry of commandEntries()) {
    const s = Math.max(
      fuzzyMatchScore(query, entry.id) ?? -Infinity,
      fuzzyMatchScore(query, entry.label) ?? -Infinity,
    );
    if (s !== -Infinity) scored.push({ entry, score: s });
  }
  // RUNNABLE ROWS FIRST, then match quality. A menu whose top rows are all
  // "not runnable here" makes the reader scroll past dead entries to reach
  // the ones the keystroke could actually run — the blocked rows still
  // list (their reason is honest information), below every live one.
  scored.sort((a, b) => {
    const aBlocked = a.entry.blockedReason !== null ? 1 : 0;
    const bBlocked = b.entry.blockedReason !== null ? 1 : 0;
    if (aBlocked !== bBlocked) return aBlocked - bBlocked;
    return b.score - a.score;
  });
  return scored.slice(0, limit);
}

export type CommandParseResult =
  | Readonly<{ ok: true; entry: CommandEntry }>
  | Readonly<{ ok: false; hint: string; matches: readonly CommandMatch[] }>;

/** Parse a composer value beginning with `/`. Exact id wins; else a single
 * unambiguous fuzzy match runs; anything else returns matches + hint. */
export function parseCommand(input: string): CommandParseResult {
  const name = input.replace(/^\/\s*/, "").trim();
  const entries = commandEntries();
  if (entries.length === 0) {
    return {
      ok: false,
      hint: "actions not loaded yet — the action registry arrives with the UI schema",
      matches: [],
    };
  }
  const exact = entries.find((e) => e.id === name);
  if (exact !== undefined) return { ok: true, entry: exact };
  const matches = matchCommands(name);
  if (name.length > 0 && matches.length === 1) {
    return { ok: true, entry: matches[0]!.entry };
  }
  return {
    ok: false,
    hint:
      name.length === 0
        ? `${entries.length} registered actions — type to filter`
        : matches.length === 0
          ? `no registered action matches "${name}"`
          : `${matches.length} actions match "${name}" — keep typing`,
    matches,
  };
}

export type CommandRunResult = Readonly<{
  ok: boolean;
  /** Plain sentence: the declared consequence on success, the reason on refusal. */
  message: string;
}>;

/** Run a command through `broker.action` — the single client write door. */
export async function runCommand(entry: CommandEntry): Promise<CommandRunResult> {
  if (entry.blockedReason !== null) {
    return { ok: false, message: `${entry.label} — ${entry.blockedReason}` };
  }
  await brokerAction(entry.block, entry.name, entry.input ?? {}, {
    invalidates: entry.invalidates,
  });
  return { ok: true, message: `${entry.label} — done. ${entry.consequence}` };
}
