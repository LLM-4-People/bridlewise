/**
 * Customization language guard — served settings words, enforced at the SOURCE.
 *
 * WHY THIS LIVES IN THE REGISTRATION LAYER
 *
 * An earlier client-side table (`src/lib/settings/customization-language.ts`
 * in the web repository's old tree) authored good plain language for every
 * customization — and died with that tree, because language kept OUTSIDE the
 * registration has to be re-authored by every consumer (cockpit, CLI, docs)
 * and silently rots when a registration changes. The registration is the one
 * artifact every consumer reads, so the registration carries the language and
 * this guard makes bad language unregisterable — the same deny-by-default
 * shape as the value/contract validation beside it in `customization.ts`.
 *
 * THE THREE RULES (modeled on the old client-side guard, moved to the source)
 *
 * 1. NAME must be behavior-shaped, not the id restated. "Search Threshold"
 *    for `search.threshold` tells a first-time user nothing the raw key did
 *    not; a Title-Cased id is still the id.
 * 2. DESCRIPTION must be a consequence sentence (>= MIN words, and not the
 *    name restated): what changes, in which direction, at what cost.
 * 3. NO IMPLEMENTATION JARGON in first position. Precision one level deeper
 *    is welcome INSIDE A PARENTHETICAL — "(the underlying score is BM25)" is
 *    fine; leading with "BM25 score threshold" is not.
 *
 * Plus the unit vocabulary: a declared `unit` is a plain lowercase word a
 * control can print next to its input ("seconds", "tokens", "results") —
 * never an internal token ("ms", "num", "bool").
 *
 * SCOPE — deny-by-default with a named quarantine. Every module served on the
 * settings surface (the `registrations/` families) is enforced. The legacy
 * exposure families that predate this guard and are not served as settings
 * (`llm`, `bandaid`, `toolResult`, `sharedMemory`) are quarantined by name
 * below; a NEW module is enforced automatically unless someone visibly adds
 * it to the quarantine. Test/demo modules registered by suites keep working
 * because enforcement is keyed to the served module list.
 */

import { InputError } from "../../kernel/errors.ts";

/**
 * Modules whose customizations must satisfy the language rules at
 * registration time. This list is asserted (in the guard's test suite) to
 * cover every module `registerAllExposure` serves, so a module cannot reach
 * the settings surface unenforced.
 */
export const LANGUAGE_ENFORCED_MODULES: ReadonlySet<string> = Object.freeze(
  new Set([
    "search",
    "privacy",
    "redaction",
    "memory",
    "awareness",
    "editor",
    "quality",
    "safety",
    "learning",
    "context",
    "tools",
    "hallucination",
    "bias",
    "mcp",
    "intelligence",
    "graph",
    "artifacts",
    "timeline",
    "performance",
    "dedup",
    "workspaceGit",
    "testExecution",
    "harnessCommands",
    "agents",
    "network",
  ]),
);

/** Whether a module's customizations are language-checked at registration. */
export function isLanguageEnforcedModule(module: string): boolean {
  return LANGUAGE_ENFORCED_MODULES.has(module);
}

/**
 * Implementation vocabulary that must not appear OUTSIDE a parenthetical in a
 * served name or description. Word-boundary matched, case-insensitive.
 */
export const CUSTOMIZATION_LANGUAGE_JARGON: readonly string[] = Object.freeze([
  "bm25",
  "subsequence",
  "preimage",
  "regex",
  "regexp",
  "csv",
  "enum",
  "bool",
  "boolean",
  "struct",
  "top-k",
  "topk",
  "mutex",
  "semaphore",
]);

/** Minimum words for a consequence description ("Default result ordering." is a label, not a consequence). */
export const MIN_CUSTOMIZATION_DESCRIPTION_WORDS = 8;

/**
 * Minimum words for a MODULE's purpose sentence (`module.ts`).
 *
 * Lower than a customization's floor on purpose: a category answers the
 * smaller question ("what does this area decide?") and padding it to eight
 * words would buy filler, not information. Still above a label — "Search
 * settings." is three words and says nothing a heading did not.
 */
export const MIN_MODULE_PURPOSE_WORDS = 6;

/**
 * Unit tokens that are internal shorthand, not printable words. A control
 * printing "ms" next to an input is serving schema vocabulary to a human.
 */
export const UNIT_TOKEN_DENYLIST: readonly string[] = Object.freeze([
  "ms",
  "msec",
  "msecs",
  "sec",
  "secs",
  "usec",
  "ns",
  "num",
  "cnt",
  "str",
  "bool",
  "int",
  "uint",
  "float",
  "obj",
  "arr",
]);

/** Printable-unit grammar: lowercase words, digits, hyphens, single spaces. */
const UNIT_GRAMMAR = /^[a-z][a-z0-9-]*(?: [a-z0-9-]+)*$/;

/**
 * Lowercase and drop everything non-alphanumeric — "the same words" detector.
 *
 * Exported because `module.ts` applies the SAME three rules to a category's
 * words that this file applies to a setting's. One owner, one behaviour: a
 * private copy there would let "restates the id" mean two things.
 */
export function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Remove parenthetical asides — jargon inside them is allowed precision. */
export function stripParentheticals(text: string): string {
  return text.replace(/\([^)]*\)/g, " ");
}

/** Count whitespace-separated words. */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter((token) => token.length > 0).length;
}

/** The minimal slice of a customization the language rules read. */
export type CustomizationLanguage = Readonly<{
  id: string;
  name: string;
  description: string;
  unit?: string;
}>;

/**
 * First language violation in a declared unit, or `null`. Exported separately
 * so a future primitive (or a doc generator) can reuse the unit vocabulary
 * without adopting the naming rules.
 */
export function customizationUnitViolation(unit: string): string | null {
  if (!UNIT_GRAMMAR.test(unit)) {
    return `unit "${unit}" is not a printable plain word (lowercase words only, e.g. "seconds", "tokens")`;
  }
  if (UNIT_TOKEN_DENYLIST.includes(unit)) {
    return `unit "${unit}" is internal shorthand — spell the word out (e.g. "milliseconds", not "ms")`;
  }
  return null;
}

/**
 * The first language violation for a customization, or `null` when the
 * language passes. Pure — the throwing wrapper is `assertCustomizationLanguage`.
 */
export function customizationLanguageViolation(
  entry: CustomizationLanguage,
): string | null {
  const { id, name, description, unit } = entry;

  // The NAME rule — the name must not be the id restated. `search.threshold` may
  // not be named "Search Threshold" (the full id Title-Cased) nor
  // "Threshold" (the id tail Title-Cased): same words, same non-information.
  const idNormalized = normalize(id);
  const tailNormalized = normalize(id.slice(id.lastIndexOf(".") + 1));
  const nameNormalized = normalize(name);
  if (nameNormalized.length === 0) return "name is empty after normalization";
  if (nameNormalized === idNormalized || nameNormalized === tailNormalized) {
    return `name "${name}" restates the id "${id}" — name the behavior, not the key`;
  }

  // The DESCRIPTION rule — a consequence sentence, not a label.
  if (wordCount(description) < MIN_CUSTOMIZATION_DESCRIPTION_WORDS) {
    return (
      `description "${description}" is ${wordCount(description)} words; ` +
      `a consequence description needs at least ${MIN_CUSTOMIZATION_DESCRIPTION_WORDS} ` +
      `(what changes, which direction, what tradeoff)`
    );
  }
  if (normalize(description) === nameNormalized) {
    return `description restates the name "${name}" — describe what changing it does`;
  }

  // The JARGON rule — no implementation vocabulary outside a parenthetical.
  const visible = stripParentheticals(`${name} ${description}`).toLowerCase();
  for (const term of CUSTOMIZATION_LANGUAGE_JARGON) {
    const pattern = new RegExp(`(?:^|[^a-z0-9])${term.replace(/[-]/g, "\\-")}(?:[^a-z0-9]|$)`);
    if (pattern.test(visible)) {
      return `"${term}" is implementation vocabulary — allowed only inside a parenthetical aside`;
    }
  }

  // Unit vocabulary — a declared unit must be printable next to an input.
  if (unit !== undefined) {
    const unitViolation = customizationUnitViolation(unit);
    if (unitViolation !== null) return unitViolation;
  }

  return null;
}

/**
 * Throw the typed {@link InputError} when a customization's served language
 * breaks the rules. Called by `registerCustomization` for every module in
 * {@link LANGUAGE_ENFORCED_MODULES} — bad language cannot enter the registry.
 */
export function assertCustomizationLanguage(entry: CustomizationLanguage): void {
  const violation = customizationLanguageViolation(entry);
  if (violation !== null) {
    throw new InputError(
      `exposure: customization "${entry.id}" language rejected: ${violation}`,
      "exposure_language_invalid",
      { exposureId: entry.id },
    );
  }
}
