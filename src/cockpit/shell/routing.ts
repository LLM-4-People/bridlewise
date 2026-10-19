/**
 * THE KEY-ROUTING CONTRACT (§2.7) — who owns a chord, and who owns Esc.
 *
 * WHAT WAS WRONG. `ShellApi.claimKey` was a `Map.set`: the LAST surface to
 * mount silently took the chord off whoever held it. Since the SWEEP mounts
 * after the FLOW, the flow's `escape` claim never fired — so three surfaces
 * (BeatMenu, LensCallout, the shared Popover) each hand-rolled a capture-phase
 * Esc listener to route around the shell's own grammar table. And the shell's
 * escape order was `room → scope → claimed`, which meant Esc with a difference
 * open inside Custody closed the whole ROOM rather than the difference. Both
 * are the same missing idea: the shell had no notion of NESTING or PRECEDENCE.
 *
 * THE CONTRACT, in two stacks.
 *
 * 1. CHORD CLAIMS — a stack per grammar target, top wins.
 *    `claim(target, handler)` pushes; the returned release pops THAT entry
 *    (not "whatever is on top"), so unmount order cannot strand a claim and a
 *    release restores the claim underneath. A claim is PERMANENT by default:
 *    it belongs to a surface that owns the chord for its whole mounted life
 *    (the FLOW's arrows, the SWEEP's scrubs). Two live permanent claims on one
 *    target is a DEFECT, not a race to mount last — the second claim is
 *    REFUSED (loudly: it throws in dev) rather than silently winning, and the
 *    incumbent keeps the chord it already answers. A surface that is
 *    only open for a while passes `{ transient: true }` and may legitimately
 *    sit on top of a permanent claim; when it releases, the permanent owner
 *    has the chord back.
 *
 * 2. DISMISSAL LAYERS — one stack for the whole shell, innermost-first.
 *    `escape` is NOT claimable: Esc has exactly one router (the shell) and
 *    surfaces participate by pushing a layer while they are open. The top of
 *    the stack is the most recently opened surface, which is the innermost
 *    one, which is the one Esc must take. One press, one level.
 *
 *    A layer remembers the ROOM CONTEXT it was pushed in. Rooms are kept alive
 *    (RoomHost) — a difference left open inside a hidden Custody is still open,
 *    it is simply not on screen — so a layer is ACTIVE only while its own room
 *    is the room on screen. That is what stops Esc, after you close Custody,
 *    from silently dismissing something nobody can see; and it is what makes
 *    reopening Custody restore the difference's claim on the key without the
 *    surface having to re-register anything.
 *
 *    A FLOOR layer (`floor: true`) is the exception, for a global CONDITION
 *    rather than a nested surface — the planted head. A past view is not
 *    "inside" whatever room happens to be open, so it is context-independent
 *    and sits BELOW the room and the scope in the ladder: Esc closes what is
 *    on screen first, and returns you to now once nothing is.
 *
 * The ladder the shell walks (Cockpit.svelte owns the walk, this module owns
 * the stacks):
 *
 *   1. the topmost dismissal layer active in the current room context
 *   2. the open ROOM
 *   3. the open SCOPE (an orphan catch — a scope opened in a room that has
 *      since been closed has no active layer left)
 *   4. the topmost FLOOR layer — the planted head, back to now
 *   5. the honest hint (routing law: a pressed chord never silently nothing)
 *
 * Guard: tests/cockpit/shell-key-routing.test.ts (mutation-tested — a silent
 * second claimant, an Esc that skips an inner surface, and an unmount that
 * does not release must each fail).
 */

import type {
  ClaimOptions,
  DismissRequest,
  GrammarTarget,
  RoomId,
} from "./contract.ts";

export type { ClaimOptions, DismissRequest };

export type ChordHandler = (ev: Readonly<{ shift: boolean }>) => void;

/** The room on screen when a layer was pushed; null = the base shell. */
export type DismissContext = RoomId | null;

export type DismissEntry = Readonly<{
  /** Plain words for the surface this dismisses — used in diagnostics. */
  label: string;
  ctx: DismissContext;
  /** A global condition rather than a nested surface (see the header). */
  floor: boolean;
  dismiss: () => void;
}>;

/**
 * A claim the contract refuses. Typed (never a raw `Error`) so it routes like
 * every other failure in this codebase, and thrown at the CLAIM SITE in dev:
 * the stack trace names the surface that tried to take a chord someone else
 * already answers, which is the one fact a silent overwrite never gave anyone.
 */
export class ShellRoutingConflict extends Error {
  constructor(message: string) {
    super(`shell key routing — ${message}`);
    this.name = "ShellRoutingConflict";
  }
}

export const ESCAPE_IS_SHELL_OWNED =
  'the "escape" chord cannot be claimed: Esc is the shell\'s dismissal ladder, ' +
  "not a chord one surface can take from another. Push a layer while the " +
  "surface is open — shell.pushDismiss({ label, dismiss }) — and the innermost " +
  "open layer gets the key.";

/** The words a second PERMANENT claimant is refused with. */
export function permanentConflict(
  target: GrammarTarget,
  held: string,
  taker: string,
): string {
  return (
    `two permanent claims on the "${target}" chord: ${held} already holds it ` +
    `and ${taker} tried to take it. One chord, one permanent owner — a claim ` +
    `that only lives while a surface is open must pass { transient: true }.`
  );
}

type ClaimEntry = {
  readonly handler: ChordHandler;
  readonly transient: boolean;
  readonly owner: string;
};

export type KeyRouting = Readonly<{
  /** Push a claim. Returns the release (idempotent, pops THIS entry). */
  claim: (
    target: GrammarTarget,
    handler: ChordHandler,
    opts?: ClaimOptions,
  ) => () => void;
  /** The handler that wins this chord right now (top of the stack). */
  handlerFor: (target: GrammarTarget) => ChordHandler | undefined;
  /** Who holds this chord, outermost first — diagnostics and guards. */
  claimants: (target: GrammarTarget) => readonly string[];

  /** Push a dismissal layer in `ctx`. Returns the release (idempotent). */
  pushDismiss: (req: DismissRequest, ctx: DismissContext) => () => void;
  /** The layer Esc takes in this context, or null. */
  topDismissal: (ctx: DismissContext) => DismissEntry | null;
  /** The floor layer Esc falls back to (the planted head), or null. */
  floorDismissal: () => DismissEntry | null;
  /** Every active layer in `ctx`, outermost first — diagnostics and guards. */
  activeLayers: (ctx: DismissContext) => readonly DismissEntry[];
}>;

export function createKeyRouting(
  opts: Readonly<{
    /** Dev: a refused claim THROWS at the claim site. Off: it is reported. */
    strict: boolean;
    /** How a refusal is stated when not strict (the shell's grammar hint). */
    onRefused: (message: string) => void;
  }>,
): KeyRouting {
  const stacks = new Map<GrammarTarget, ClaimEntry[]>();
  let layers: DismissEntry[] = [];

  /** Refuse a claim, loudly. Never silently: the incumbent keeps the chord
   * either way, and the reason is said in the one place that can act on it. */
  function refuse(message: string): void {
    if (opts.strict) throw new ShellRoutingConflict(message);
    opts.onRefused(message);
  }

  const claim: KeyRouting["claim"] = (target, handler, options = {}) => {
    const transient = options.transient === true;
    const owner = options.owner ?? "an unnamed surface";

    // Esc is not a chord anyone owns. Said loudly at the claim site, because
    // the alternative — accepting the claim and quietly never calling it —
    // is exactly the defect this contract exists to remove.
    if (target === "escape") {
      refuse(ESCAPE_IS_SHELL_OWNED);
      return () => undefined;
    }

    const stack = stacks.get(target) ?? [];
    if (!transient) {
      const held = stack.find((e) => !e.transient);
      if (held !== undefined) {
        // REFUSED, not overwritten: the incumbent keeps the chord. A steal
        // that "works" is worse than one that fails, because it fails later
        // and somewhere else.
        refuse(permanentConflict(target, held.owner, owner));
        return () => undefined;
      }
    }

    const entry: ClaimEntry = { handler, transient, owner };
    stack.push(entry);
    stacks.set(target, stack);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const live = stacks.get(target);
      if (live === undefined) return;
      const at = live.indexOf(entry);
      if (at >= 0) live.splice(at, 1);
      if (live.length === 0) stacks.delete(target);
    };
  };

  const handlerFor: KeyRouting["handlerFor"] = (target) => {
    const stack = stacks.get(target);
    if (stack === undefined || stack.length === 0) return undefined;
    return stack[stack.length - 1]!.handler;
  };

  const claimants: KeyRouting["claimants"] = (target) =>
    (stacks.get(target) ?? []).map((e) => e.owner);

  const pushDismiss: KeyRouting["pushDismiss"] = (req, ctx) => {
    const entry: DismissEntry = {
      label: req.label,
      ctx,
      floor: req.floor === true,
      dismiss: req.dismiss,
    };
    layers = [...layers, entry];
    let released = false;
    return () => {
      if (released) return;
      released = true;
      layers = layers.filter((l) => l !== entry);
    };
  };

  const topDismissal: KeyRouting["topDismissal"] = (ctx) => {
    for (let i = layers.length - 1; i >= 0; i -= 1) {
      const l = layers[i]!;
      if (!l.floor && l.ctx === ctx) return l;
    }
    return null;
  };

  const floorDismissal: KeyRouting["floorDismissal"] = () => {
    for (let i = layers.length - 1; i >= 0; i -= 1) {
      const l = layers[i]!;
      if (l.floor) return l;
    }
    return null;
  };

  const activeLayers: KeyRouting["activeLayers"] = (ctx) =>
    layers.filter((l) => !l.floor && l.ctx === ctx);

  return {
    claim,
    handlerFor,
    claimants,
    pushDismiss,
    topDismissal,
    floorDismissal,
    activeLayers,
  };
}
