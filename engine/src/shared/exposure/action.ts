/**
 * Shared exposure system — Action primitive (UNIFIED).
 *
 * An Action is a named, invokable operation exposed by a module for any
 * consumer to execute. Actions are the "verbs" of the harness: clear a
 * cache, reindex, prune, rollback, reset — anything that mutates state or
 * triggers a side effect on behalf of an unprivileged consumer.
 *
 * One of three exposure primitives (Signal, Action, Customization) owned by
 * `src/shared/exposure/`. ALL modules register their actions here — never
 * ad-hoc.
 *
 * UNIFIED API (EXP470): this file merges the three previously-fragmented
 * families into ONE source of truth:
 * - A.1 (EXP425/436): `registerAction(Action)` + `executeAction(id)` — the
 * canonical registration + execute path (kept). `executeAction` now
 * handles BOTH sync and async `execute` callbacks (await normalises the
 * result), so A.2's `invokeAction` (sync-only) is subsumed.
 * - A.2 (EXP462): `invokeAction` — subsumed by `executeAction` (which
 * awaits sync results transparently). No separate sync verb remains.
 * - B (EXP457): `defineAction(...)` positional ergonomics —
 * re-implemented as a thin wrapper over `registerAction` (taking the
 * `execute` callback the unified model requires).
 *
 * Per the root policy invariant `effectBoundariesEnforced: true`, actions
 * own their effects. A consumer calling `executeAction(id)` does not need to
 * know the module's internals; the module's registered `execute` callback
 * performs the effect and returns a typed result.
 */

import { deepFreeze } from "../../kernel/integrity.ts";
import { InputError } from "../../kernel/errors.ts";
import { recordEffectAsync } from "../../timeline/recorded-effect.ts";
import { createCatalog } from "./catalog.ts";
import { type ExposureContract } from "./contract.ts";

/** Argument declaration for an action. */
export type ActionArg = Readonly<{
  type: "number" | "string" | "boolean";
  required: boolean;
  description: string;
}>;

/** An action's optional string argument: its text, or `undefined` when absent or empty. */
export function optionalStringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The result of executing an action — sync or async, JSON-serialisable. */
export type ActionResult = unknown;

/** A registered action — a named, invokable operation. */
export type Action = Readonly<{
  /** Stable dotted id, e.g. `"search.clearCache"`. */
  id: string;
  /** Owning module id, e.g. `"search"`. */
  module: string;
  /** Human-readable name, e.g. `"Clear Cache"`. */
  name: string;
  /** Short description for documentation + LLM consumption. */
  description: string;
  /** Optional argument schema. */
  args?: Readonly<Record<string, ActionArg>>;
  /** Invoke the action. May be sync or async; returns a JSON-serialisable result. */
  execute: (args?: Readonly<Record<string, unknown>>) => ActionResult | Promise<ActionResult>;
  /**
   * Shared exposure metadata — determinism class, effect timing, audience,
   * visibility predicate. Optional; see `contract.ts`. Present on EVERY
   * primitive so a generator can treat them uniformly.
   */
  contract?: ExposureContract;
}>;

/** Internal registry row: the action plus its registration order. */
/** Validate a single arg value against its declared type. */
function coerceArg(
  name: string,
  declared: ActionArg,
  value: unknown,
): number | string | boolean {
  switch (declared.type) {
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new InputError(`exposure: action arg "${name}" must be a finite number`);
      }
      return value;
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        throw new InputError(`exposure: action arg "${name}" must be a boolean`);
      }
      return value;
    }
    case "string": {
      if (typeof value !== "string") {
        throw new InputError(`exposure: action arg "${name}" must be a string`);
      }
      return value;
    }
    default: {
      throw new InputError(`exposure: action arg "${name}" has unknown type "${declared.type}"`);
    }
  }
}

/**
 * Validate the args object against an action's declared schema.
 *
 * An absent OPTIONAL arg is OMITTED from the result, never substituted.
 * Substituting a placeholder (this used to yield the empty string, whatever
 * the declared type) breaks two contracts at once:
 *
 *   - The declared TYPE. `memory.retrieve` declares `hit` as a boolean and
 *     received `""` — a string — which every consumer then reads as a
 *     boolean-shaped value that is not one.
 *   - The action's OWN default. Every `execute` body reaches for its default
 *     with `args?.x ?? fallback`, and `""` is not nullish, so the fallback
 *     never ran: `search.query`'s documented default of 5 results silently
 *     became `Number("")`, i.e. 0.
 *
 * Omission is what makes `?? fallback` mean what it says, and it keeps the
 * declared type honest: a key is either absent or correctly typed.
 */
function validateActionArgs(
  action: Action,
  args: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, number | string | boolean>> | undefined {
  if (!action.args) return args as Readonly<Record<string, number | string | boolean>> | undefined;
  const declared = action.args;
  const out: Record<string, number | string | boolean> = {};
  for (const [name, decl] of Object.entries(declared)) {
    const value = args?.[name];
    if (value === undefined || value === null) {
      if (decl.required) {
        throw new InputError(`exposure: action arg "${name}" is required`);
      }
      continue;
    }
    out[name] = coerceArg(name, decl, value);
  }
  return deepFreeze(out);
}

/**
 * Storage + the seven generic operations come from the shared catalog. Only
 * ACTION-specific validation (the `execute` function) stays here.
 */
const catalog = createCatalog<Action>("action", (action) => {
  if (typeof action.execute !== "function") {
    throw new InputError(`exposure: action "${action.id}" execute must be a function`);
  }
});

/**
 * Register an action. Throws on duplicate id or invalid shape.
 * Returns the registered action.
 */
export function registerAction(action: Action): Action {
  return catalog.register(action);
}

export function getAction(id: string): Action | undefined {
  return catalog.get(id);
}

/**
 * Execute an action by id with optional args (canonical, A.1).
 * Handles BOTH sync and async `execute` callbacks: the result is always
 * awaited, so a sync `execute` returning a plain value works identically to
 * an async one returning a Promise. This subsumes A.2's `invokeAction`.
 *
 * ── THE EXECUTION IS RECORDED, BECAUSE RUNNING IT IS HOW IT GETS RECORDED ──
 *
 * This file's own opening line says what these verbs are: "clear a cache,
 * reindex, prune, rollback, reset — anything that mutates state or triggers a
 * side effect". Nineteen of the registered ones are clear/reset/prune/compact
 * verbs, including `memory.clear`, `editor.clearHistory`, `learning.clearRules`
 * and `context.clear`. They ran through this one function and left no trace at
 * all: state destroyed, and afterwards no way to say it had ever been there,
 * who removed it, or when.
 *
 * `recordEffectAsync` is the SAME wrapper the block-action door already uses
 * (`server/blocks/define.ts` wraps every block action in
 * `recordEffectAsync("action", "<block>/<name>", …)`), with the same kind, so
 * both doors land in one ledger lane and a reader does not have to know which
 * door a verb came through. It is not a second recording path; it is this
 * choke point joining the existing one.
 *
 * IT WRAPS `execute`, NOT THE WHOLE FUNCTION. An unregistered id or invalid
 * arguments throw before this point and record nothing, which is correct: no
 * effect was attempted, and an event for it would be a record of something
 * that did not happen. From here on the wrapper holds both ends of the call,
 * so the outcome is observed rather than declared, and a `clear` that threw
 * halfway is recorded as failed rather than not recorded at all.
 *
 * With no ledger attached — a CLI, a script, a test — `setEffectSink` has
 * never been called and the wrapper is a pass-through, so this costs nothing
 * where there is nothing to record to.
 */
export async function executeAction(
  id: string,
  args?: Readonly<Record<string, unknown>>,
): Promise<ActionResult> {
  const action = catalog.get(id);
  if (!action) throw new InputError(`exposure: action "${id}" not registered`);
  const validated = validateActionArgs(action, args);
  return recordEffectAsync("action", id, async () => action.execute(validated));
}

/** List all registered actions in registration order. */
export function listActions(): readonly Action[] {
  return catalog.list();
}

/** Count registered actions. */
export function countActions(): number {
  return catalog.count();
}

/** List all actions owned by a module, in registration order. */
export function listActionsByModule(module: string): readonly Action[] {
  return catalog.listByModule(module);
}

/** Remove an action (test/reset hook). */
export function unregisterAction(id: string): boolean {
  return catalog.unregister(id);
}

/** Clear all actions (test/reset hook). */
export function clearActions(): void {
  catalog.clear();
}

// ---------------------------------------------------------------------------
// Ergonomic positional helper (B family, re-implemented over registerAction).
// ---------------------------------------------------------------------------

/**
 * Define + register an action positionally (B ergonomics over A.1
 * registration). The `execute` callback is required (the unified model needs
 * a runtime effect; a definition-only action with no execute is not useful to
 * a consumer that calls `executeAction`). The `id` is a SHORT id unique
 * within `module`; the registered dotted id is `${module}.${id}`.
 */
export function defineAction(
  module: string,
  id: string,
  name: string,
  description: string,
  execute: (args?: Readonly<Record<string, unknown>>) => ActionResult | Promise<ActionResult>,
  args?: Readonly<Record<string, ActionArg>>,
): Action {
  const fullId = `${module}.${id}`;
  const action: Action = args !== undefined ? { id: fullId, module, name, description, execute, args } : { id: fullId, module, name, description, execute };
  return registerAction(action);
}
