/**
 * The generic exposure catalog — the ONE implementation of registry storage
 * shared by every exposure primitive.
 *
 * WHY THIS EXISTS
 *
 * `signal.ts`, `action.ts` and `customization.ts` each carried their own
 * private `Map<string, Row>` plus an insertion counter, and each re-declared
 * the same seven operations (`register`, `get`, `list`, `count`,
 * `listByModule`, `unregister`, `clear`) over it. The bodies were identical
 * apart from the noun: three copies of the insertion-order sort, three copies
 * of the duplicate-id rejection, three byte-identical dotted-id regexes.
 *
 * That is a "No Scattered Helpers" violation, and it has a concrete cost:
 * the binding requirement is that every signal, task, event, action and
 * RESULT be exposed, which means three more primitives are coming. Under the
 * old shape each new primitive meant another copy of the same seven
 * functions — the registry would grow by duplication rather than by
 * declaration.
 *
 * The catalog owns storage and the invariants that are common to all
 * primitives. Each primitive module keeps ONLY what is genuinely specific to
 * it: its entry type, its extra validation, and its `define*` sugar.
 *
 * Adding a primitive is now: declare its entry type, call `createCatalog`,
 * and export the bound operations. No new storage, no new sort, no new
 * duplicate check.
 */

import { InputError } from "../../kernel/errors.ts";
import { type ExposureContract, validateContract } from "./contract.ts";

/**
 * The shape every catalog entry must satisfy. These four fields are what the
 * generic operations (grouping, validation, reporting) rely on; everything
 * else belongs to the specific primitive.
 */
export type CatalogEntry = Readonly<{
  /** Stable dotted id, e.g. `"search.threshold"`. */
  id: string;
  /** Owning module id, e.g. `"search"`. */
  module: string;
  /** Human-readable name. */
  name: string;
  /** Short description, for documentation and LLM consumption. */
  description: string;
  /**
   * Shared metadata (determinism class, effect timing, audience, visibility
   * predicate). Optional — see `contract.ts` for why it is not required.
   *
   * Declared HERE rather than on each primitive so every primitive, including
   * ones not yet written, carries the same vocabulary and is validated the
   * same way. A primitive cannot accidentally omit it.
   */
  contract?: ExposureContract;
}>;

/**
 * A dotted, namespaced id: `module.name`, lowercase-initial segments.
 *
 * One definition. `signal.ts` and `action.ts` previously carried this exact
 * regex independently, so a change to the id grammar had to be made in two
 * places and could silently be made in only one.
 */
const VALID_ID = /^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+$/u;

/** Whether an id is a well-formed namespaced exposure id. */
export function isValidExposureId(id: string): boolean {
  return VALID_ID.test(id);
}

/** The operations a catalog exposes, bound to one primitive's entry type. */
export type Catalog<T extends CatalogEntry> = Readonly<{
  /** Kind name, used in error messages, e.g. `"signal"`. */
  kind: string;
  /** Register an entry. Throws `InputError` on an invalid or duplicate id. */
  register: (entry: T) => T;
  /** Look up by id. */
  get: (id: string) => T | undefined;
  /** All entries, in registration order. */
  list: () => readonly T[];
  /** Number of registered entries. */
  count: () => number;
  /** Entries belonging to one module, in registration order. */
  listByModule: (module: string) => readonly T[];
  /** Remove one entry. Returns whether it existed. */
  unregister: (id: string) => boolean;
  /** Remove every entry and reset insertion order. */
  clear: () => void;
}>;

/**
 * Create a catalog for one exposure primitive.
 *
 * `validate` is the hook for primitive-specific invariants — a signal's
 * `value` must be a function, an action's `execute` must be a function, a
 * customization's default must match its declared type. The generic checks
 * (id shape, required metadata, duplicate id) are applied first and always,
 * so a primitive cannot forget them.
 */
export function createCatalog<T extends CatalogEntry>(
  kind: string,
  validate?: (entry: T) => void,
): Catalog<T> {
  type Row = Readonly<{ entry: T; order: number }>;
  const registry = new Map<string, Row>();
  let insertionOrder = 0;

  function register(entry: T): T {
    if (!isValidExposureId(entry.id)) {
      throw new InputError(`exposure: invalid ${kind} id "${entry.id}"`);
    }
    if (entry.module.length === 0) {
      throw new InputError(`exposure: ${kind} "${entry.id}" missing module`);
    }
    if (entry.name.length === 0) {
      throw new InputError(`exposure: ${kind} "${entry.id}" missing name`);
    }
    if (entry.description.length === 0) {
      throw new InputError(`exposure: ${kind} "${entry.id}" missing description`);
    }
    // Contract metadata is validated centrally: an unknown determinism class
    // or audience is rejected at registration rather than surfacing later as
    // a silently-unrendered control.
    validateContract(entry.id, entry.contract);
    // Primitive-specific invariants run AFTER the universal ones, so their
    // messages are never masked by a malformed id.
    validate?.(entry);
    if (registry.has(entry.id)) {
      throw new InputError(`exposure: ${kind} "${entry.id}" already registered`);
    }
    registry.set(entry.id, { entry, order: insertionOrder++ });
    return entry;
  }

  function list(): readonly T[] {
    return Array.from(registry.values())
      .sort((a, b) => a.order - b.order)
      .map((row) => row.entry);
  }

  return Object.freeze({
    kind,
    register,
    get: (id: string): T | undefined => registry.get(id)?.entry,
    list,
    count: (): number => registry.size,
    listByModule: (module: string): readonly T[] =>
      list().filter((entry) => entry.module === module),
    unregister: (id: string): boolean => registry.delete(id),
    clear: (): void => {
      registry.clear();
      insertionOrder = 0;
    },
  });
}
