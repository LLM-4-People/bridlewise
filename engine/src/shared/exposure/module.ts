/**
 * Shared exposure system — the MODULE declaration (the category primitive).
 *
 * WHY THIS EXISTS
 *
 * Every signal, action and customization already carries a `module` — the
 * namespace before the first dot (`search.threshold` → `search`). That token
 * is an identity, not a name: "search", "bias", "hallucination" and
 * "awareness" are the words the code uses for those areas, and a settings
 * surface that prints them is serving registry vocabulary to a person who has
 * never read the registry.
 *
 * So every consumer that wanted to GROUP the exposure surface had to author
 * the missing words itself. Two independent copies existed, both outside the
 * registry:
 *
 *   - `src/lib/settings/customization-language.ts::MODULE_NAMES` in the web
 *     tree — a hand-written `{ search: "Code search", … }` table;
 *   - `server/schema/derive-modules.ts::exposureTitle` — a derivation that
 *     produces "Search signals" and cannot produce "Code search", because no
 *     derivation can invent a word the vocabulary does not contain.
 *
 * A hand-authored map in a consumer is exactly the failure this registry
 * exists to prevent: the twelfth module registered tomorrow gets no category
 * at all, and nothing fails — it silently renders under its raw namespace, or
 * not at all. The words belong where the module is declared, next to the
 * signals/actions/customizations they describe, so ONE declaration serves the
 * cockpit, the CLI, the reports and the LLM alike.
 *
 * DEGRADE, NEVER VANISH. A module with no declaration still renders: its
 * title falls back to `humanizeModuleId` (the same declared-first /
 * derived-otherwise shape the navigation groups already use in
 * `contracts/module-contract.ts::groupLabel`). The fallback is honest — a
 * spelled-out id — and `undeclaredModules()` names the gap so a guard can
 * fail on it rather than a surface hiding it.
 *
 * The words are held to the SAME language rules as a customization's
 * (`language.ts`): a title that restates the id, a purpose that is a label
 * rather than a sentence, or implementation jargon outside a parenthetical is
 * rejected at registration. Bad category words are unregisterable, exactly as
 * bad setting words are.
 */

import { InputError } from "../../kernel/errors.ts";
import {
  CUSTOMIZATION_LANGUAGE_JARGON,
  MIN_MODULE_PURPOSE_WORDS,
  normalize,
  stripParentheticals,
  wordCount,
} from "./language.ts";

/**
 * A module namespace: one lowercase-initial token, no dot. Deliberately NOT
 * `catalog.ts::isValidExposureId`, whose grammar REQUIRES a dot — a module id
 * is the part before that dot, so the two grammars are complements, not
 * copies.
 */
const VALID_MODULE_ID = /^[a-z][a-zA-Z0-9]*$/u;

/** Whether a token is a well-formed exposure module id. */
export function isValidModuleId(id: string): boolean {
  return VALID_MODULE_ID.test(id);
}

/**
 * One module of the exposure surface, declared in plain words.
 *
 * This is the whole authoring surface for a category. There is no ordering
 * field: consumers order by whatever they measure (how many settings a
 * category holds, how recently one changed), and a declared rank would be a
 * second opinion that drifts from the first.
 */
export type ExposureModule = Readonly<{
  /** The namespace every id in this module is prefixed with, e.g. `"search"`. */
  id: string;
  /**
   * What this area is CALLED, in the product's own words — never the id
   * spelled differently. `search` is called "Code search"; `bias` is called
   * "Fair-answer checks". Rejected at registration when it restates the id.
   */
  title: string;
  /**
   * What this area DOES, as a sentence someone who has never read the code
   * can act on. Answers "what would I be changing if I opened this?".
   * Rejected at registration when it is too short to be a sentence, when it
   * restates the title, or when it leads with implementation vocabulary.
   */
  purpose: string;
}>;

const modules = new Map<string, ExposureModule>();

/**
 * A module id spelled for a human — the FALLBACK when nothing is declared.
 *
 * `search` → `Search`, `sharedMemory` → `Shared memory`. Mirrors
 * `contracts/module-contract.ts::humanizeId` in behaviour deliberately: the
 * two trees cannot import each other, and a reader who has met one must not
 * have to learn a second rule for the other.
 */
export function humanizeModuleId(id: string): string {
  const spaced = id.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").replace(/[-_]/gu, " ").trim();
  if (spaced.length === 0) return id;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The first language violation in a module declaration, or `null`. Pure — the
 * throwing wrapper is {@link registerExposureModule}. Exported so a guard, a
 * doc generator or a settings surface can check words against the SAME rules
 * the validator rejects against, rather than restating them.
 */
export function exposureModuleViolation(entry: ExposureModule): string | null {
  const { id, title, purpose } = entry;

  if (!isValidModuleId(id)) {
    return `module id "${id}" is not a namespace token (one lowercase-initial word, no dot)`;
  }

  // The TITLE rule — the category name must not be the id restated. A
  // namespace Title-Cased is the namespace, and the whole reason this
  // declaration exists is that the namespace is not a name.
  const titleNormalized = normalize(title);
  if (titleNormalized.length === 0) return `module "${id}" has an empty title`;
  if (titleNormalized === normalize(id)) {
    return `module "${id}" title "${title}" restates the id — name the area, not the namespace`;
  }

  // The PURPOSE rule — a sentence a reader can act on, not a second label.
  if (wordCount(purpose) < MIN_MODULE_PURPOSE_WORDS) {
    return (
      `module "${id}" purpose "${purpose}" is ${wordCount(purpose)} words; ` +
      `a category needs at least ${MIN_MODULE_PURPOSE_WORDS} (what this area decides, in plain words)`
    );
  }
  if (normalize(purpose) === titleNormalized) {
    return `module "${id}" purpose restates the title "${title}" — say what the area decides`;
  }

  // The JARGON rule — no implementation vocabulary outside a parenthetical.
  const visible = stripParentheticals(`${title} ${purpose}`).toLowerCase();
  for (const term of CUSTOMIZATION_LANGUAGE_JARGON) {
    // The vocabulary is letters, digits and hyphens only, and a hyphen
    // OUTSIDE a character class is already literal — escaping it here is what
    // the `u` flag rejects as an invalid escape.
    const pattern = new RegExp(`(?:^|[^a-z0-9])${term}(?:[^a-z0-9]|$)`, "u");
    if (pattern.test(visible)) {
      return `module "${id}": "${term}" is implementation vocabulary — allowed only inside a parenthetical aside`;
    }
  }

  return null;
}

/**
 * Declare one module of the exposure surface. Called by the module's own
 * registration file, beside the signals/actions/customizations it names.
 *
 * Idempotent for an IDENTICAL re-declaration (the registration files are
 * themselves idempotent); a DIFFERENT declaration for the same id is rejected
 * rather than silently overwriting, because two disagreeing category names
 * for one namespace is precisely the drift this primitive removes.
 */
export function registerExposureModule(entry: ExposureModule): ExposureModule {
  const violation = exposureModuleViolation(entry);
  if (violation !== null) {
    throw new InputError(
      `exposure: module declaration rejected: ${violation}`,
      "exposure_module_invalid",
      { exposureId: entry.id },
    );
  }
  const existing = modules.get(entry.id);
  if (existing !== undefined) {
    if (existing.title === entry.title && existing.purpose === entry.purpose) return existing;
    throw new InputError(
      `exposure: module "${entry.id}" is already declared as "${existing.title}" — ` +
        `one namespace cannot carry two category names`,
      "exposure_module_duplicate",
      { exposureId: entry.id },
    );
  }
  const frozen = Object.freeze({ ...entry });
  modules.set(entry.id, frozen);
  return frozen;
}

/** Every declared module, in declaration order. */
export function listExposureModules(): readonly ExposureModule[] {
  return Object.freeze([...modules.values()]);
}

/** One declared module, or `undefined` when the namespace declared none. */
export function getExposureModule(id: string): ExposureModule | undefined {
  return modules.get(id);
}

/** Number of declared modules. */
export function countExposureModules(): number {
  return modules.size;
}

/**
 * The name to show for a module: DECLARED first, derived otherwise. The
 * single owner of that precedence — a consumer writing `decl?.title ??
 * humanize(id)` itself would be a second place it lives.
 */
export function exposureModuleTitle(id: string): string {
  const declared = modules.get(id)?.title;
  return declared !== undefined && declared.length > 0 ? declared : humanizeModuleId(id);
}

/**
 * The module ids that OWN registered entries but declare no category — the
 * gap, named. Consumers render the derived fallback; a guard fails on a
 * non-empty list, so a new registration file cannot ship categoryless.
 */
export function undeclaredModules(owning: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const missing: string[] = [];
  for (const id of owning) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (!modules.has(id)) missing.push(id);
  }
  return Object.freeze(missing);
}

/** Remove one declaration. Returns whether it existed. */
export function unregisterExposureModule(id: string): boolean {
  return modules.delete(id);
}

/** Remove every declaration (test/reset hook only). */
export function clearExposureModules(): void {
  modules.clear();
}
