/**
 * THE MOTION LAW, MADE STRUCTURAL — a thing may move only when something
 * happened, and it must NAME what.
 *
 * DESIGN-COCKPIT-V2 §11.8 states the rule and prescribes the mechanism:
 *
 *   > all motion must trace a recorded event or a user gesture (the
 *   > no-fake-motion law, now a guard: ANIMATION UTILITIES ACCEPT AN
 *   > EVENT/GESTURE HANDLE, NOT A TIMER).
 *
 * The rule was honoured by hand and the mechanism did not exist. That is the
 * half of this law that gets faked, because the faking is invisible: a
 * `@keyframes` block and an `animation:` line look identical whether the thing
 * they move is reporting a real event or performing liveliness. Both are
 * declarative CSS with no argument to inspect.
 *
 * ── THE TEST THIS ENCODES ─────────────────────────────────────────────────
 *
 * A pulse that means "working" is information. A pulse that means "we have a
 * pulse" is decoration. The difference is not in the pixels — it is whether
 * anything, anywhere, can say WHICH SIGNAL the movement is bound to. So the
 * only way to start a motion here is to present a `MotionCause`, and every
 * `MotionCause` carries plain words naming its signal. A motion that can name
 * none cannot be spelled, which is the same move the response grammar makes
 * with `pending`: an anonymous wait has nothing to bind to.
 *
 * ── ★ WHAT A TIMER CAN AND CANNOT DO HERE — CORRECTED, AND DRIVEN ─────────
 *
 * This section used to read "WHY A CAUSE CANNOT COME FROM A CLOCK", and it
 * claimed there is no factory that takes a duration, a delay, a timestamp or
 * an interval. THAT IS TRUE OF THE SIGNATURES AND FALSE OF THE PROPERTY. All
 * three timer routes were driven and all three STARTED A MOTION:
 *
 *   a timeout            + `becauseChanged`, where the timer is what ticks
 *                          the value it then reports as changed;
 *   an animation frame   + `becauseArrived("frame-" + t)`;
 *   an interval          + `becauseOfGesture` on a retained event.
 *
 * `becauseArrived` accepts a clock reading as an identity, because an identity
 * is a string and a clock reading is a string. Nothing in these signatures can
 * tell them apart, and a docstring that says otherwise sends the next reader
 * looking for a barrier that is not there.
 *
 * ★ THE HONEST PROPERTY IS WEAKER AND STILL WORTH THE MECHANISM: A
 * TIMER-DRIVEN MOTION MUST LIE IN A PLACE A READER CAN SEE. `moves` stamps
 * `data-motion-signal` on the element, so a motion that claims `"frame-17734"`
 * as its signal is sitting in the DOM saying so, and anything — a test, an
 * audit, a person with an inspector open — can read it and disagree. RUNG 3
 * FOR STARTING IS ABOUT NAMING, NOT ABOUT CLOCKS: what is impossible is moving
 * something ANONYMOUSLY, not moving something on a schedule.
 *
 * What each factory demands, with the honest weight of each:
 *
 *   `becauseOfGesture` — a real `Event`. A timer callback receives none, so
 *                        producing one means constructing a fake event on
 *                        purpose, which is an act rather than an oversight.
 *                        A RETAINED event defeats it, and the single-use spend
 *                        below is what makes that cost one cause per tick
 *                        rather than one for all of them.
 *   `becauseArrived`   — the identity of the thing that arrived. A NON-EMPTY
 *                        STRING is the whole of the check, so this one is a
 *                        naming requirement and not a barrier. Driven: a clock
 *                        reading passes it.
 *   `becauseChanged`   — a genuine transition, REFUSED when the two values are
 *                        equal. THIS ONE IS GENUINE and survived attack: a
 *                        poll firing every 400ms over an unchanged value gets
 *                        an exception, not an animation, and the only way past
 *                        it is to have something the timer actually MOVES —
 *                        which is a changed value, which is news. "Nothing has
 *                        changed" and "nothing should move" are the same
 *                        sentence, and here they are the same code path.
 *
 * ── AND A CAUSE IS SPENT WHEN IT IS USED ──────────────────────────────────
 *
 * Otherwise the whole mechanism is defeated in one line: obtain a cause once,
 * keep it, and hand it to a `setInterval`. So a cause is single-use. Replaying
 * one throws a sentence naming that exact defect.
 *
 * ── LADDER (§0) ───────────────────────────────────────────────────────────
 *
 * Rung 1 — unavailable: CSS animation is a property of the style system, and
 * no engine or OS facility can be asked "was there an event behind this".
 *
 * Rung 2 — unavailable, specifically: the bad state is not a bad VALUE. A
 * decorative animation and an earned one are the same string
 * (`"rise 150ms ease-out"`) in the same property; there is no type that could
 * be inhabited by one and not the other, because the difference is not in the
 * animation at all — it is in whether anything happened. A type system has no
 * access to that.
 *
 * Rung 3 — REACHED for starting one, AND IT IS ABOUT NAMING: `moves` is the
 * only thing that sets the attribute the animations are keyed to, and its
 * argument is a `MotionCause` that no object literal can produce (the brand).
 * Moving a thing ANONYMOUSLY is not possible; moving one on a schedule is, and
 * the schedule then has to write its own name on the element.
 *
 * Rung 4 — REACHED for the abuse: the equality refusal and the single-use
 * spend, both at the factories, which are the one door. The equality refusal
 * is the one rung here that a timer cannot walk around.
 *
 * Rung 5, AND IT IS THE FLOOR RATHER THAN THE DESIGN. Three ways out of this
 * module exist and all three are the same shape — a motion this module never
 * sees. NAMED HERE RATHER THAN DISCOVERED LATER:
 *
 *   1. `animation:` in a component's own scoped `<style>` block. Scoped CSS is
 *      not something a module can reach.
 *   2. An INLINE `style="animation: …"` on markup. Not a stylesheet at all, so
 *      a scan of `<style>` blocks cannot see it.
 *   3. A Web Animations API call on a node. No CSS is involved at any point,
 *      so neither of the two scans above can see it, and neither can the
 *      `[data-motion]` dressing this module owns.
 *
 * MEASURED BEFORE BEING CLOSED, so the size of the floor is a number rather
 * than a worry: both were at ZERO occurrences across `src/` when the scan was
 * extended over them (`grep -rn`, unit: matching lines). All three are now
 * scanned by this module's guard over the whole component tree, with plants
 * driving each direction — but the scan is a floor and not a mechanism, and
 * nobody should read the rungs above and believe it is redundant.
 */

/**
 * WHAT KINDS OF THING ARE ALLOWED TO CAUSE MOTION — declared once. Every
 * consumer (the type, the factories, the attribute, the guard's universe)
 * derives from this object.
 */
export const MOTION_CAUSES = {
  /** A person did something with a pointer or a key. */
  gesture: { means: "someone acted, and this is the acknowledgement" },
  /** Something the system recorded arrived and is now on screen. */
  arrival: { means: "a recorded thing arrived, and this is where it landed" },
  /** A measured value became a different measured value. */
  change: { means: "a measured value changed, and this is the change" },
} as const;

export type MotionCauseId = keyof typeof MOTION_CAUSES;

/** Every cause id, derived — never written out a second time. */
export const MOTION_CAUSE_IDS = Object.keys(MOTION_CAUSES) as readonly MotionCauseId[];

/**
 * THE MOTIONS THIS SYSTEM HAS — the closed vocabulary, and the whole of it.
 *
 * Each names the moving thing in the terms a reader would use, and each is
 * dressed exactly once, by the token owner, against `[data-motion="<id>"]`.
 * Adding a motion is adding an entry here plus its rule there, and the guard
 * fails until both exist — which is the direction that keeps a declaration
 * and its dressing from drifting apart.
 */
export const MOTIONS = {
  /** A sheet arriving from the edge it belongs to. */
  "sheet-in": { means: "a sheet arrived from the edge it belongs to" },
  /** A menu or popover rising into place under the thing that opened it. */
  rise: { means: "a surface rose into place where it was opened" },
  /** A numeral rolling to a new reading. */
  roll: { means: "a measured numeral rolled to its new reading" },
  /** A recorded thing landed on the element that represents it. */
  arrive: { means: "a recorded thing landed where it is now on screen" },
  spark: { means: "a successful action or recorded activity released a brief spark" },
  /** The open room became a different room — a top-level cut, not a sheet. */
  cut: { means: "the open room became a different room" },
} as const;

export type MotionId = keyof typeof MOTIONS;

export const MOTION_IDS = Object.keys(MOTIONS) as readonly MotionId[];

// ── The cause ─────────────────────────────────────────────────────────────

declare const MOTION_BRAND: unique symbol;

/**
 * Why a thing is about to move. Obtainable only from the factories below —
 * an object literal cannot produce the brand, so there is no shape to
 * hand-write and no way to route around the evidence each factory demands.
 */
export type MotionCause = Readonly<{
  cause: MotionCauseId;
  /** The signal, in plain words. This is the field the whole law is about. */
  signal: string;
}> & { readonly [MOTION_BRAND]: true };

/**
 * THE SPEND LEDGER — one bit per cause, and DELIBERATELY NOT A SECOND COPY OF
 * THE CAUSE.
 *
 * It held `{ cause, signal, spent }`, which put the cause id and the signal in
 * TWO places: on the value and in this map. Both were written from the same
 * normalised `words`, so they agreed — and that is precisely the shape that
 * rots, because there were then two independent chances to store the RAW
 * string instead of the normalised one and NEITHER was observed by a test.
 * Driven at the parent commit: replacing either `signal: words` with `signal`
 * left the suite at rc 0, 13/13 passed. Two copies, one of them unobservable.
 *
 * Membership in this map is what proves a value came from a factory, so the
 * identity check is unchanged. Once it has passed, the cause's own fields are
 * the answer — and the trim has exactly one place to be right.
 */
type Spendable = { spent: boolean };

const spend = new WeakMap<object, Spendable>();

export class MotionContract extends Error {
  readonly code = "cockpit_contract";
  constructor(message: string) {
    super(message);
    this.name = "MotionContract";
  }
}

/**
 * THE ONE PLACE A SIGNAL IS NORMALISED.
 *
 * `words` is the trimmed name and it is what the cause CARRIES — surrounding
 * whitespace is how a name was typed, not part of it, and `data-motion-signal`
 * is read by anything with an inspector open. The refusal below is stated in
 * terms of `words` for the same reason: a signal of three spaces names
 * nothing, and a check against the raw string would have accepted it as a name.
 */
function make(cause: MotionCauseId, signal: string): MotionCause {
  const words = typeof signal === "string" ? signal.trim() : "";
  if (words.length === 0) {
    throw new MotionContract(
      `a ${cause} cause must NAME its signal in plain words; it was given none. ` +
        "A motion that cannot say what it is bound to is decoration, and the " +
        "remedy is to delete it rather than to name it vaguely",
    );
  }
  // NULL-PROTOTYPE, and identity is why: `spend` is a WeakMap keyed on THIS
  // object, and Svelte's $state proxy wraps every plain-prototype object
  // assigned into component state — so a cause stored in $state came back
  // as a proxy, missed the map, and `consume` refused a genuine cause as a
  // forgery (driven: every undocked scope open threw MotionContract through
  // ScopeHost's $state arrival). The proxy returns objects whose prototype
  // is neither Object nor Array untouched (svelte/internal/client/proxy.js),
  // so minting off the null prototype ends the class for every holder,
  // rather than fixing one component's storage choice. Frozen separately,
  // because immutability is its own promise.
  const value = Object.freeze(
    Object.assign(Object.create(null) as object, { cause, signal: words }),
  ) as unknown as MotionCause;
  spend.set(value, { spent: false });
  return value;
}

/**
 * Someone acted. The `Event` is the handle §11.8 asks for — it is the thing a
 * timer does not have and cannot obtain without deliberately constructing a
 * lie.
 */
export function becauseOfGesture(event: Event, signal: string): MotionCause {
  if (!(event instanceof Event)) {
    throw new MotionContract(
      "a gesture cause needs the real event that carried the gesture; it was " +
        "given something else. If there is no event, there was no gesture",
    );
  }
  return make("gesture", signal);
}

/** A recorded thing arrived. Its identity is the evidence. */
export function becauseArrived(identity: string, signal: string): MotionCause {
  if (typeof identity !== "string" || identity.trim().length === 0) {
    throw new MotionContract(
      "an arrival cause needs the identity of the thing that arrived; time " +
        "passing is not an arrival",
    );
  }
  return make("arrival", signal);
}

/**
 * A measured value became a different one.
 *
 * REFUSED WHEN THEY ARE EQUAL, and that refusal is the load-bearing line of
 * this module. A re-measurement that produced the same reading is not news,
 * and a poll that fires on a schedule over an unchanged value is precisely
 * the fake motion the law exists to stop — here it raises rather than moves.
 */
export function becauseChanged(signal: string, from: unknown, to: unknown): MotionCause {
  if (Object.is(from, to)) {
    throw new MotionContract(
      `nothing changed about "${signal}" — a re-measurement that produced the ` +
        "same reading is not an event, and moving for it is the fake motion " +
        "this door exists to refuse",
    );
  }
  return make("change", signal);
}

/**
 * Consume a cause. Returns what the element must be stamped with.
 *
 * Exported because the guard drives it, and because a caller outside Svelte
 * (a future canvas painter deciding whether to animate) needs the same door.
 */
export function consume(cause: MotionCause, motion: MotionId): Readonly<{
  "data-motion": MotionId;
  "data-motion-cause": MotionCauseId;
  "data-motion-signal": string;
}> {
  const record = spend.get(cause);
  if (record === undefined) {
    throw new MotionContract(
      "this is not a motion cause — causes come from becauseOfGesture, " +
        "becauseArrived or becauseChanged, and nothing else can produce one",
    );
  }
  if (record.spent) {
    throw new MotionContract(
      `the cause "${cause.signal}" has already moved something. A cause is ` +
        "spent when it is used, so a stored cause cannot be replayed on a " +
        "timer — obtain a new one from the thing that actually happened",
    );
  }
  if (!(motion in MOTIONS)) {
    throw new MotionContract(
      `"${motion}" is not a declared motion (${MOTION_IDS.join(", ")})`,
    );
  }
  record.spent = true;
  // THE CAUSE'S OWN FIELDS, now that its identity is proved. The ledger above
  // carries one bit and no copy of them, so what lands on the element is the
  // value the factory normalised rather than a twin that agreed with it.
  return Object.freeze({
    "data-motion": motion,
    "data-motion-cause": cause.cause,
    "data-motion-signal": cause.signal,
  });
}

/**
 * THE SVELTE ACTION — the only thing in the cockpit that starts an animation.
 *
 *     <aside use:moves={{ motion: "sheet-in", cause: becauseChanged(...) }}>
 *
 * The attribute is removed when the animation ends, so the element returns to
 * rest and the next movement needs a new cause. A `null` parameter means "not
 * now", which is what lets a caller decide per render without reaching for a
 * cause it does not have.
 */
export type MovesParam = Readonly<{ motion: MotionId; cause: MotionCause }> | null;

export function moves(node: HTMLElement, param: MovesParam) {
  const clear = (): void => {
    node.removeAttribute("data-motion");
    node.removeAttribute("data-motion-cause");
    node.removeAttribute("data-motion-signal");
  };
  const onEnd = (): void => clear();
  node.addEventListener("animationend", onEnd);
  node.addEventListener("animationcancel", onEnd);

  const apply = (next: MovesParam): void => {
    if (next === null) {
      clear();
      return;
    }
    // Svelte re-runs the action update when the host re-renders with the
    // SAME param (RoomHost's keep-alive each-block). A second consume
    // would throw "already moved". If this node is already wearing that
    // movement, the cause was spent on it — do not replay. After
    // animationend the attributes are gone, so a timer handing the same
    // object back still hits consume and is refused.
    if (
      node.getAttribute("data-motion") === next.motion &&
      node.getAttribute("data-motion-signal") === next.cause.signal
    ) {
      return;
    }
    const attrs = consume(next.cause, next.motion);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  };

  apply(param);

  return {
    update: apply,
    destroy(): void {
      node.removeEventListener("animationend", onEnd);
      node.removeEventListener("animationcancel", onEnd);
    },
  };
}
