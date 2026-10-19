/**
 * PROVIDER TEMPLATE TOKENS — the grammar, the matcher, the stream filter.
 *
 * A model that was served with its chat template's control tokens preserved
 * (a serving stack that decodes with special tokens intact so its reasoning
 * parser can find them) can EMIT those tokens inside its answer text. The
 * measured instance: gemma-4-31b's documented "ghost thought channel" —
 * `<|channel>thought\n<channel|>` — arriving at the end of an assistant
 * message, persisting to the DB, rendering in the chat, and then re-entering
 * the LLM context on the next turn, teaching the model its own corruption.
 *
 * ── THE GRAMMAR (canonical, not invented here) ─────────────────────────────
 *
 * The gemma-4 control-token lattice, from Google's own thinking-mode table
 * (ai.google.dev/gemma/docs/capabilities/thinking):
 *
 *   open markers    `<|turn>`  `<|channel>`     — `<|` + name + `>`
 *   close markers   `<turn|>`  `<channel|>`     — `<` + name + `|>`
 *   full lattice    `<|think|>`                 — `<|` + name + `|>`
 *   empty channel   `<|channel>thought\n<channel|>` — open + channel name +
 *                   close with nothing else between: one template unit.
 *
 * The same lattice carries the oai/llama.cpp control vocabulary
 * (`<|im_start|>`, `<|im_end|>`, `<|endoftext|>`), so one grammar covers
 * every family that leaks this way. Names are letters, digits and
 * underscores — no spaces, no angle brackets, no pipes, one line — which is
 * what makes the lattice structurally unambiguous: HTML never puts a pipe
 * next to an angle bracket, and neither does markdown, a code fence or
 * prose. Marker names are matched case-sensitively (lowercase in every
 * real vocabulary); anything wider is never stripped.
 *
 * ── DENY BY DEFAULT, TWICE ─────────────────────────────────────────────────
 *
 * 1. Only lattice shapes strip. Angle brackets WITHOUT a pipe
 *    (`<start_of_turn>`, `<div>`, `<p>`) are never touched — they are
 *    indistinguishable from markup and user text, so the honest answer for
 *    them is not to guess.
 * 2. Inside a channel declaration, only the NAME-ONLY span strips whole.
 *    `<|channel>thought\n<channel|>` is the documented empty declaration;
 *    `<|channel>actual reasoning text<channel|>` carries MODEL PROSE
 *    between the markers, so only the markers strip and the prose stays —
 *    deleting prose would be editing the model's answer, not sanitizing
 *    transport syntax.
 *
 * ── THE TWO DOORS, ONE RESULT ──────────────────────────────────────────────
 *
 * `stripTemplateTokens` is the batch form. `createTemplateTokenFilter` is
 * the streaming form: a provider stream can split a marker across chunk
 * boundaries (`<|chan` + `nel>`), so the filter HOLDS BACK from the last
 * unresolved `<` and releases only text that can no longer become part of a
 * marker. Both record exactly what they removed, and they agree by
 * construction — the filter's flush IS the batch stripper over the held
 * tail — which the tests pin by driving every split point of the incident
 * string through both doors.
 *
 * Neither door ever sees USER text: the filter is wired only where
 * provider-OUTPUT deltas cross into the harness (the llm-bridge stream
 * loop). User messages reach the provider through buildLLMMessages and are
 * user fact, verbatim.
 */

/** Marker names: letters, digits, underscores. The narrowness IS the
 *  deny-by-default — no real control-token vocabulary uses anything else,
 *  and every widening is a new chance to touch real text. */
const NAME_CHAR = /[a-zA-Z0-9_]/;

/**
 * End-of-input disqualifier for the filter's flush: a char that can never
 * appear inside a marker, so an incomplete candidate resolves as plain
 * text the moment the stream is known to be over. Never appears in real
 * input — it is appended, never matched against.
 */
const SENTINEL = "\u0000";

/** `<channel|>` — the close marker the channel declaration awaits. */
const CHANNEL_CLOSE = "<channel|>";

/** What a strip removed, in reading order. The trace the response document
 *  carries so no edit is silent and the pre-strip text stays recoverable. */
export type TemplateTokenStrip = Readonly<{
  readonly text: string;
  readonly stripped: readonly string[];
}>;

/** One candidate decision: hold (still forming), strip (a template token),
 *  or emit (provably plain text). `chars` covers how many characters of the
 *  candidate-bearing string the decision is final for. */
type Resolve =
  | Readonly<{ kind: "hold" }>
  | Readonly<{ kind: "strip"; chars: number }>
  | Readonly<{ kind: "emit"; chars: number }>;

/**
 * Resolve at most one candidate at the START of `s`, which begins with `<`.
 * `chars` is how many characters the decision covers. Everything this
 * function decides is FINAL for that span: a `strip` span contains no other
 * candidate (names have no `<`), and an `emit` span is provably not part of
 * any marker — the decision char that ended it can never extend one.
 */
function resolveOne(s: string): Resolve {
  if (s.length < 2) return { kind: "hold" };
  const c1 = s[1]!;
  if (c1 === "|") {
    // `<|…` — leading-pipe or full lattice (or a channel open).
    let k = 2;
    while (k < s.length && NAME_CHAR.test(s[k]!)) k += 1;
    if (k === s.length) return { kind: "hold" };
    const after = s[k]!;
    if (after === ">") {
      const name = s.slice(2, k);
      if (name !== "channel") return { kind: "strip", chars: k + 1 };
      // Channel open matched. The declaration continues with optional name +
      // whitespace, then the close marker — decide which case this is. The
      // between is only ever name/whitespace here (two words would put a
      // name char after the whitespace run, failing the `<`-or-end check
      // below), so the whole span is decidable from what follows.
      let b = k + 1;
      while (b < s.length && /\s/.test(s[b]!)) b += 1;
      while (b < s.length && NAME_CHAR.test(s[b]!)) b += 1;
      while (b < s.length && /\s/.test(s[b]!)) b += 1;
      if (b === s.length) return { kind: "hold" };
      const at = s[b]!;
      if (at !== "<") {
        // Prose or punctuation before any close: not a declaration. The open
        // marker still strips alone; the between flows on as plain text.
        return { kind: "strip", chars: k + 1 };
      }
      const rest = s.slice(b);
      // A PROPER prefix of the close marker can still complete — hold. (An
      // equal or longer string has already decided, and equality is a match,
      // not a hold: `startsWith` is reflexive, so the length guard is what
      // keeps the canonical `<|channel>thought\n<channel|>` from hanging.)
      if (rest.length < CHANNEL_CLOSE.length && CHANNEL_CLOSE.startsWith(rest)) {
        return { kind: "hold" };
      }
      if (rest.startsWith(CHANNEL_CLOSE)) {
        // The whole declaration — open, name, whitespace, close — is one
        // template unit.
        return { kind: "strip", chars: b + CHANNEL_CLOSE.length };
      }
      // A `<` that is not the close: the declaration failed. Strip the open
      // marker; the between (name/whitespace only, no `<` inside) and the
      // new candidate resume through the outer loop.
      return { kind: "strip", chars: k + 1 };
    }
    if (after === "|") {
      if (k + 1 === s.length) return { kind: "hold" };
      if (s[k + 1] === ">") return { kind: "strip", chars: k + 2 };
      return { kind: "emit", chars: k };
    }
    // A char that can never extend a leading-pipe marker: `<|name` ends here
    // as plain text. The disqualifying char itself stays for rescan — it may
    // be the `<` of the next candidate.
    return { kind: "emit", chars: k };
  }
  if (NAME_CHAR.test(c1)) {
    // `<name…` — trailing-pipe lattice (`<turn|>`, `<channel|>`), or not a
    // marker at all (`<div>`).
    let k = 1;
    while (k < s.length && NAME_CHAR.test(s[k]!)) k += 1;
    if (k === s.length) return { kind: "hold" };
    const after = s[k]!;
    if (after === "|") {
      if (k + 1 === s.length) return { kind: "hold" };
      if (s[k + 1] === ">") return { kind: "strip", chars: k + 2 };
      return { kind: "emit", chars: k };
    }
    if (after === ">") {
      // `<div>` — a complete tag with no pipe. Plain text, emitted whole.
      return { kind: "emit", chars: k + 1 };
    }
    return { kind: "emit", chars: k };
  }
  // `<` followed by anything else (a space, another `<`, `>`): the `<` alone
  // is plain text; the next char resumes the scan.
  return { kind: "emit", chars: 1 };
}

/**
 * The streaming door. `push` feeds a provider text delta and returns the
 * text that is now safe to emit (possibly empty while a candidate is being
 * held). `flush` releases whatever is still held once the stream is over —
 * by running the batch stripper over it, so the two doors agree by
 * construction. `stripped` is the forensic trace, in order.
 */
export function createTemplateTokenFilter(): Readonly<{
  push(delta: string): string;
  flush(): string;
  readonly stripped: readonly string[];
}> {
  let pending = "";
  const stripped: string[] = [];
  const drain = (): string => {
    let out = "";
    for (;;) {
      const i = pending.indexOf("<");
      if (i < 0) {
        out += pending;
        pending = "";
        return out;
      }
      out += pending.slice(0, i);
      pending = pending.slice(i);
      const r = resolveOne(pending);
      if (r.kind === "hold") return out;
      if (r.kind === "strip") {
        stripped.push(pending.slice(0, r.chars));
        pending = pending.slice(r.chars);
        continue;
      }
      out += pending.slice(0, r.chars);
      pending = pending.slice(r.chars);
    }
  };
  /**
   * END-OF-INPUT semantics: nothing more can arrive, so every remaining
   * candidate resolves NOW — an incomplete name can never complete, and an
   * unterminated candidate is model text, never dropped. Implemented by
   * resolving against the pending text plus a sentinel disqualifier (a char
   * that can never appear in a marker), then advancing at most to the end of
   * the REAL text. Self-contained on purpose: routing this through the batch
   * wrapper made flush → wrapper → flush mutual recursion on a held tail
   * that never resolves — the measured stack overflow.
   */
  const drainFinal = (): string => {
    let out = "";
    while (pending.length > 0) {
      const i = pending.indexOf("<");
      if (i < 0) {
        out += pending;
        pending = "";
        break;
      }
      if (i > 0) {
        out += pending.slice(0, i);
        pending = pending.slice(i);
        continue;
      }
      const r = resolveOne(pending + SENTINEL);
      if (r.kind === "hold") {
        // Unreachable with the sentinel appended — held only by construction
        // before it. Defensive: emit rather than loop or drop.
        out += pending;
        pending = "";
        break;
      }
      const n = Math.min(
        r.kind === "strip" || r.kind === "emit" ? r.chars : 0,
        pending.length,
      );
      if (r.kind === "strip") {
        stripped.push(pending.slice(0, n));
      } else {
        out += pending.slice(0, n);
      }
      pending = pending.slice(n);
    }
    return out;
  };
  return {
    push(delta: string): string {
      if (delta.length === 0) return "";
      pending += delta;
      return drain();
    },
    flush(): string {
      if (pending.length === 0) return "";
      return drainFinal();
    },
    get stripped(): readonly string[] {
      return stripped;
    },
  };
}

/**
 * The batch door: assembled text in, stripped text + reading-order trace
 * out. It is the streaming door fed once and flushed — literally the same
 * resolver, not a second matcher — so the two doors cannot disagree on any
 * input, at any chunk split, by construction.
 */
export function stripTemplateTokens(text: string): TemplateTokenStrip {
  const filter = createTemplateTokenFilter();
  const out = filter.push(text) + filter.flush();
  return { text: out, stripped: filter.stripped };
}
