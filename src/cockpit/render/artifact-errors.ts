/**
 * THE ARTIFACT RUNTIME ERROR CHANNEL — the ONE `message` listener in the
 * cockpit, and the only thing that may ever ride on it.
 *
 * ── WHY A DOOR THE PRODUCT DELIBERATELY CLOSED IS BEING OPENED ────────────
 *
 * `server/artifact-check.ts` proves an artifact PARSES. It runs the same V8
 * the browser will run over every classic `<script>` and, on a real corpus,
 * reproduced Chrome's verdicts byte-identically: 3 of 3 broken artifacts
 * caught with correct artifact-relative line numbers, 0 false positives on 9
 * working ones. That is a real guarantee and it is not this one.
 *
 * A document that parses can still die on its first statement. `null.x` on
 * line 1 compiles perfectly and produces a DEAD RECTANGLE — no explanation to
 * the user, and none to the model, whose `create_artifact` call already
 * returned `ok: true` seconds earlier. That is exactly the silent-failure
 * class DESIGN-PERFORMANCE §1 L3 exists to refuse: a surface showing emptiness
 * when the truth is "it broke".
 *
 * The only way a sandboxed opaque-origin frame can say so is `postMessage`.
 * No sandbox token blocks it and none ever will. So the containment that used
 * to be "the cockpit registers ZERO message listeners" becomes a narrower,
 * mechanically stronger claim:
 *
 *     EXACTLY ONE `message` LISTENER EXISTS IN THE COCKPIT. IT LIVES HERE.
 *     IT ACCEPTS ONE MESSAGE SHAPE — A RUNTIME-ERROR REPORT — FROM A WINDOW
 *     IT HAS ITSELF REGISTERED, AND IT DOES NOTHING WITH IT BUT RECORD IT.
 *
 * `tests/cockpit/artifact-containment.test.ts` §F holds both halves: a second
 * listener anywhere under `src/cockpit/**` fails, and any other message shape
 * reaching this one is dropped.
 *
 * ── THE SECURITY PROPERTIES, AND HOW EACH IS ENFORCED ─────────────────────
 *
 * 1. `event.origin` IS USELESS HERE, AND MUST NOT BE "FIXED" INTO AN ORIGIN
 *    CHECK. A frame sandboxed WITHOUT `allow-same-origin` has an OPAQUE
 *    origin; everything it posts arrives with `event.origin === "null"`. Every
 *    such frame in the document — and every other opaque-origin context on the
 *    page — shares that exact string, so an origin comparison would accept an
 *    impostor and authenticate nothing. The identity that IS unforgeable is
 *    the WINDOW: `event.source` is set by the browser, cannot be spoofed by
 *    the sender, and is compared here against the `contentWindow` of a
 *    specific registered <iframe> element. THAT is the check. If you are
 *    reading this while adding `event.origin === location.origin`, it will
 *    reject every real report and accept nothing extra.
 *
 * 2. DENY BY DEFAULT. `parseReport` is a total function to `RawReport | null`.
 *    It requires an exact key set, exact types and an exact channel tag, and
 *    it COERCES NOTHING — a message with a numeric `message`, an extra field,
 *    or a missing one is dropped, not repaired. A source that no registered
 *    frame owns is dropped before its payload is even examined.
 *
 * 3. ATTRIBUTION IS DERIVED, NEVER DECLARED. The report carries no artifact
 *    id, on purpose: an id in the payload is a string the sender chose, so a
 *    hostile artifact could report its own crash AS a neighbouring artifact —
 *    and the neighbour has no way to deny it. The frame a report belongs to is
 *    the frame whose `contentWindow` the browser named as the source. There is
 *    no other way to be attributed here, which is why the payload has no room
 *    for one.
 *
 * 4. A HOSTILE ARTIFACT CAN FLOOD, AND THE FLOOD IS BOUNDED HONESTLY.
 *    `while (true) parent.postMessage(x, "*")` is one line. Note what is and
 *    is not new: those events were already being queued and dispatched at this
 *    window BEFORE this module existed — a listener-free page pays nearly the
 *    same dispatch cost — so the flood is not a door this channel opened. What
 *    this channel could add is UNBOUNDED STATE and unbounded re-render, and
 *    that is what `REPORT_CAP` bounds: at most five reports are KEPT per
 *    frame, everything after is COUNTED and the count is stated to the reader
 *    ("N further errors were reported and are not shown"). It is never
 *    silently dropped — a suppressed error the user cannot see the existence
 *    of is the same lie as an empty rectangle. Subscriber notification past
 *    the cap is throttled (`SUPPRESS_NOTIFY_MS`) with a TRAILING flush, so a
 *    flood costs a bounded number of renders and the final count is still
 *    exact.
 *
 * 5. INBOUND-ONLY, FOR ERRORS, AND HARD TO REVERSE. Nothing here posts INTO a
 *    frame; this module contains no `postMessage` call and the containment
 *    test forbids one in the artifact renderer. The accepted shape is a frozen
 *    key list (`REPORT_KEYS`) which the test pins BY VALUE, so widening the
 *    channel into a general RPC means editing a guard that names every field —
 *    a deliberate act, not a drive-by addition.
 *
 * ── MEASURED IN CHROME, IN A REAL SANDBOXED FRAME ─────────────────────────
 *
 * Not read off a spec. Each row was run inside `sandbox="allow-scripts"` plus
 * the shared CSP, with the probe on ARTIFACT line 7, and the beat's sentence
 * read back off the rendered strip:
 *
 *   top.location.href = …          SecurityError, reported, at line 7 col 18
 *   parent.location.href (read)    SecurityError, reported, at line 7 col 25
 *   localStorage.length            SecurityError, reported, at line 7 col 9
 *   null.x (sync)                  TypeError,     reported, at line 7
 *   requestPointerLock()           SecurityError, reported, at line 7 col 15
 *   requestFullscreen()            TypeError "Disallowed by permissions
 *                                  policy", reported, at line 7
 *   20,000 posts in a loop         5 kept, "19995 further errors were
 *                                  reported and are not shown"; the host's
 *                                  main thread stayed responsive throughout
 *   a working artifact             nothing reported, nothing rendered
 *
 * Chrome's `window.onerror` lineno for a srcdoc document IS the srcdoc line,
 * so `ARTIFACT_LINE_OFFSET` (1, the CSP meta) is the whole correction.
 *
 * ── WHAT IS NOT CLAIMED ───────────────────────────────────────────────────
 *
 * The reporter is INSIDE the artifact's own document, so the artifact can
 * disable it: assigning its own `window.onerror` replaces ours. An artifact
 * that does this reports nothing and the beat shows a live frame, exactly as
 * it does today. This channel makes failure LEGIBLE when the document does not
 * fight it; it is not a supervisor and does not pretend to be one. Equally: a
 * report is the ARTIFACT'S account of its own failure. It is rendered as such,
 * never as our measurement.
 *
 * AND SOME REAL FAILURES ARE NOT EXCEPTIONS AT ALL. Measured, in the same
 * frame: `navigator.geolocation.getCurrentPosition(ok, fail)` is refused by
 * permissions policy through its FAILURE CALLBACK — no exception is thrown and
 * no promise rejects, so nothing reaches this channel and the beat stays
 * silent. (Wrapped in a promise the same denial arrives as an
 * unhandledrejection and IS reported.) Likewise a sandbox-blocked top-level
 * navigation that Chrome only writes to the console. This channel reports what
 * the browser RAISES; it does not read the console, and a silent beat means
 * "nothing was raised", not "nothing went wrong".
 *
 * ── THE HALF THAT IS NOT BUILT, AND EXACTLY WHY ───────────────────────────
 *
 * THE USER SEES THE FAILURE. THE MODEL STILL DOES NOT. That is stated here
 * rather than left for someone to discover, because it is the same gap the
 * preimage-hash fix closed on the server side: an error the model cannot read
 * is an error it cannot retry against.
 *
 * `create_artifact` answered `ok: true` seconds before the document threw, so
 * the tool result cannot carry this. Every OTHER carrier that exists today was
 * examined, and each one is blocked for a reason worth writing down:
 *
 *   `POST /api/run/start` — the natural home. Its body is a `z.strictObject`
 *   (`RUN_START_SCHEMA`), so an `observations` field is a SERVER change.
 *
 *   `POST /api/chats/:id/messages` with `role: "user"` — would reach the model
 *   verbatim on the next turn, and is REFUSED here on principle: it writes a
 *   user turn the user never wrote into the durable record. Forging authorship
 *   to deliver a true sentence is the honest-data law traded for convenience,
 *   and the record is the one thing this product cannot afford to make up.
 *   (It also has no client wrapper, which is the smaller objection.)
 *
 *   …with `role: "error"` — honest provenance, and it reaches the RECORD, but
 *   `server/chat-history.ts` excludes `error` and `system` rows from the LLM
 *   history by design, so the model would not see it. Including them is a
 *   SERVER change.
 *
 *   `POST /api/memory` + `run.compose/pin` — reachable from the cockpit today
 *   with no server change, and still wrong: a memory is durable across every
 *   future conversation and retrieved by lexical overlap, so a transient
 *   render failure in one frame would become a permanent recalled fact. Wrong
 *   home, not a missing hop.
 *
 * So the last hop genuinely requires `server/**`, which this work was
 * forbidden to touch. Everything up to it is here and live: the fault is
 * recorded per beat (`stateOf`), attributed unforgeably, and already phrased in
 * the sentence the model would need (`sayError`). A wiring agent needs
 * `stateOf(beatId)` plus one server-side carrier; no new client API.
 */

import { sandboxedSrcdoc } from "./html-preview.ts";
import { ARTIFACT_REPORT_MAX_MESSAGE, ARTIFACT_REPORT_MAX_NAME } from "./render-config.ts";

// ── The reporter, and the line arithmetic it forces ──────────────────────

/**
 * The script injected ahead of every artifact document.
 *
 * It installs `window.onerror` and an `unhandledrejection` listener, and posts
 * what the BROWSER gave it. It invents nothing: a missing line arrives as
 * `null`, never as `0` and never as a guess. It counts nothing and caps
 * nothing — the host is the single capper, so the number the host states is
 * the number of reports that actually reached it (see property 4).
 *
 * `onerror` returns false so the error still reaches the frame's own console:
 * this channel observes, it does not swallow.
 *
 * A REJECTION HAS NO `lineno`, BUT IT OFTEN HAS A REAL ONE ANYWAY. This was
 * found from a user's report against the first version of this channel: a game
 * calling `requestPointerLock()` was refused by the sandbox, and the beat said
 * "the browser reported no location" — true of `unhandledrejection`'s own
 * fields, and needlessly so, because Chrome had put the location in the
 * reason's STACK:
 *
 *     SecurityError: Blocked pointer lock … 'allow-pointer-lock' is not set.
 *         at about:srcdoc:8:15
 *
 * `loc()` reads that. It is not stack PARSING in the fragile sense and it is
 * not a guess: it accepts a frame ONLY when the URL is exactly `about:srcdoc`,
 * which is the document we composed and the only document in this frame. A
 * frame from anywhere else — an extension, a blob, a worker — is not our
 * document and yields no location, because attributing someone else's line to
 * the model's file is precisely the fabrication this module refuses. When no
 * such frame is present the answer stays null and the beat says so.
 *
 * The line numbers it forwards are RAW SRCDOC LINES. The conversion to
 * artifact-relative lines is done on this side, by `toArtifactLine`, because
 * the wrapper's size is this module's fact and not the artifact's.
 */
export const REPORTER_SCRIPT =
  "<script>(function(){var W=window,P=W.parent;if(!P||P===W)return;" +
  'var CH="artifact-runtime-error";' +
  "function num(v){return typeof v===\"number\"&&isFinite(v)&&v>0?v:null}" +
  "function str(v,n){try{return String(v==null?\"\":v).slice(0,n)}catch(e){return \"\"}}" +
  "function loc(r){try{var m=/(?:^|[\\s(@])about:srcdoc:(\\d+):(\\d+)/.exec(String(r&&r.stack||\"\"));" +
  "return m?[+m[1],+m[2]]:[null,null]}catch(e){return [null,null]}}" +
  "function send(k,name,msg,line,col){try{P.postMessage({ch:CH,v:1,kind:k," +
  "name:str(name,120),message:str(msg,2000),line:num(line),column:num(col)},\"*\")}catch(e){}}" +
  "W.onerror=function(m,s,l,c,e){send(\"error\",e&&e.name?e.name:\"Error\",e&&e.message?e.message:m,l,c);return false};" +
  "W.addEventListener(\"unhandledrejection\",function(ev){var r=ev&&ev.reason,L=loc(r);" +
  "send(\"unhandledrejection\",r&&r.name?r.name:\"UnhandledRejection\",r&&r.message?r.message:r,L[0],L[1])});" +
  "})();</script>";

/**
 * HOW MANY LINES THE WRAPPER PUTS ABOVE THE ARTIFACT'S FIRST LINE.
 *
 * DERIVED, never asserted. The frame's document is
 * `sandboxedSrcdoc(REPORTER_SCRIPT + content)`, so the artifact's line 1 sits
 * at srcdoc line `ARTIFACT_LINE_OFFSET + 1`. Counting the newlines in exactly
 * that prefix means the constant cannot drift when the shared CSP owner grows
 * a line or this file's reporter does. `artifact-runtime-errors.test.ts` pins
 * the relationship both ways, and the browser check pins it against Chrome.
 */
export const ARTIFACT_LINE_OFFSET: number = countNewlines(
  sandboxedSrcdoc(REPORTER_SCRIPT),
);

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) if (s.charCodeAt(i) === 10) n += 1;
  return n;
}

/**
 * A raw srcdoc line turned into the line of the document THE MODEL WROTE —
 * the same register `server/artifact-check.ts` reports parse errors in
 * ("at line 12 of the document").
 *
 * Returns null when the browser gave no usable line, and ALSO when the line
 * lands inside our own wrapper. The second case is not a rounding problem: a
 * line ≤ the offset did not come from the artifact at all, and reporting
 * "line 0" or clamping to line 1 would attribute our code's failure to the
 * model's document. No location is the honest answer.
 */
export function toArtifactLine(raw: number | null): number | null {
  if (raw === null) return null;
  const line = raw - ARTIFACT_LINE_OFFSET;
  return line >= 1 ? line : null;
}

// ── The message shape, and nothing else ──────────────────────────────────

/** The channel tag. One value; a message without it is not for us. */
export const CHANNEL = "artifact-runtime-error";

/**
 * EVERY key an accepted message may carry, and the complete list of them.
 * Pinned by value in the containment test: this is what makes "the channel is
 * inbound-only, for errors" hard to reverse casually. Adding a field here is
 * editing the guard.
 */
export const REPORT_KEYS: readonly string[] = Object.freeze([
  "ch",
  "v",
  "kind",
  "name",
  "message",
  "line",
  "column",
]);

/** The two things an artifact document can report. Nothing else is a kind. */
export const REPORT_KINDS: readonly string[] = Object.freeze([
  "error",
  "unhandledrejection",
]);


/** A validated report, still carrying the RAW srcdoc line. */
export type RawReport = Readonly<{
  kind: "error" | "unhandledrejection";
  name: string;
  message: string;
  line: number | null;
  column: number | null;
}>;

/** A report as the beat shows it: artifact-relative, and stamped on arrival. */
export type ArtifactRuntimeError = Readonly<{
  kind: "error" | "unhandledrejection";
  name: string;
  message: string;
  /** 1-based line of the document the model wrote; null = not reported. */
  line: number | null;
  column: number | null;
  /** Host clock at receipt. Ours, not the artifact's. */
  at: number;
}>;

/** What a frame's beat knows about its runtime failures. */
export type ArtifactErrorState = Readonly<{
  errors: readonly ArtifactRuntimeError[];
  /** Reports that arrived after the cap: counted, stated, never hidden. */
  suppressed: number;
}>;

export const EMPTY_STATE: ArtifactErrorState = Object.freeze({
  errors: Object.freeze([]) as readonly ArtifactRuntimeError[],
  suppressed: 0,
});

/**
 * VALIDATE, NEVER COERCE. Returns the report, or null for everything else.
 *
 * The key set must match `REPORT_KEYS` EXACTLY — not "contains", not "at
 * least". An unexpected key is the shape of someone extending this channel by
 * accident, and it is refused at the door rather than ignored, because
 * ignoring it is how a second protocol quietly gets a foothold.
 */
export function parseReport(data: unknown): RawReport | null {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const o = data as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== REPORT_KEYS.length) return null;
  for (const k of REPORT_KEYS) if (!Object.prototype.hasOwnProperty.call(o, k)) return null;
  if (o["ch"] !== CHANNEL) return null;
  if (o["v"] !== 1) return null;
  const kind = o["kind"];
  if (typeof kind !== "string" || !REPORT_KINDS.includes(kind)) return null;
  const name = o["name"];
  const message = o["message"];
  if (typeof name !== "string" || typeof message !== "string") return null;
  const line = intOrNull(o["line"]);
  const column = intOrNull(o["column"]);
  if (line === undefined || column === undefined) return null;
  return {
    kind: kind as "error" | "unhandledrejection",
    name: name.slice(0, ARTIFACT_REPORT_MAX_NAME),
    message: message.slice(0, ARTIFACT_REPORT_MAX_MESSAGE),
    line,
    column,
  };
}

/**
 * `null` or a positive finite integer; `undefined` means "not that", which the
 * caller turns into a refusal. A float, a string of digits, `0`, `NaN` and
 * `Infinity` are all refusals rather than things to round — a line number the
 * sender did not send is not a line number we may invent.
 */
function intOrNull(v: unknown): number | null | undefined {
  if (v === null) return null;
  if (typeof v !== "number") return undefined;
  if (!Number.isSafeInteger(v) || v <= 0) return undefined;
  return v;
}

// ── The channel ──────────────────────────────────────────────────────────

/** Reports KEPT per frame. Past this they are counted and stated. */
export const REPORT_CAP = 5;

/** While suppressing, subscribers are told at most this often. */
export const SUPPRESS_NOTIFY_MS = 500;

/** What `deliver` decided, so a test can assert the decision and not a shadow. */
export type Verdict =
  | "accepted"
  | "suppressed"
  | "unknown-source"
  | "malformed";

type Entry = {
  el: HTMLIFrameElement;
  state: ArtifactErrorState;
  listeners: Set<(s: ArtifactErrorState) => void>;
  lastNotify: number;
  timer: ReturnType<typeof setTimeout> | null;
};

/**
 * The channel. One instance (`artifactErrors`) is the cockpit's; the class is
 * exported so a test can build an isolated one instead of leaking state
 * between cases.
 */
export class ArtifactErrorChannel {
  private readonly frames = new Map<string, Entry>();
  private bound: ((e: MessageEvent) => void) | null = null;
  private readonly target: Window | null;

  constructor(target: Window | null = typeof window === "undefined" ? null : window) {
    this.target = target;
  }

  /**
   * Watch one frame element under one key, and stop watching when the
   * returned function is called.
   *
   * The ELEMENT is taken, not its `contentWindow`: a frame's window is
   * replaced on navigation and on remount, and reading it fresh at message
   * time means a stale window can never be accepted as the live one. It also
   * keeps `contentWindow` out of the renderer component entirely, which the
   * containment test still forbids there.
   */
  watch(key: string, el: HTMLIFrameElement): () => void {
    const prior = this.frames.get(key);
    if (prior !== undefined) {
      prior.el = el;
    } else {
      this.frames.set(key, {
        el,
        state: EMPTY_STATE,
        listeners: new Set(),
        lastNotify: 0,
        timer: null,
      });
    }
    this.install();
    return () => {
      const cur = this.frames.get(key);
      if (cur !== undefined && cur.el === el) {
        cur.el = el;
        // The element is gone but the RECORD is not: a beat scrolled out of
        // the flow's window and back must still say that its artifact threw.
        // Only `reset` forgets, and only a restart calls it.
      }
    };
  }

  /** Read a frame's current state. Absence of a record is the empty state. */
  stateOf(key: string): ArtifactErrorState {
    return this.frames.get(key)?.state ?? EMPTY_STATE;
  }

  /** Subscribe to one frame's state. Fires immediately with what is known. */
  subscribe(key: string, fn: (s: ArtifactErrorState) => void): () => void {
    let entry = this.frames.get(key);
    if (entry === undefined) {
      entry = {
        el: null as unknown as HTMLIFrameElement,
        state: EMPTY_STATE,
        listeners: new Set(),
        lastNotify: 0,
        timer: null,
      };
      this.frames.set(key, entry);
    }
    entry.listeners.add(fn);
    fn(entry.state);
    const e = entry;
    return () => {
      e.listeners.delete(fn);
    };
  }

  /**
   * Forget a frame's failures. Called when the frame is REBUILT (the "restart"
   * verb): a new document has not thrown yet, and showing the old document's
   * errors over it would be stale by construction.
   */
  reset(key: string): void {
    const entry = this.frames.get(key);
    if (entry === undefined) return;
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = null;
    entry.lastNotify = 0;
    entry.state = EMPTY_STATE;
    this.emit(entry);
  }

  /** Drop a frame entirely. The flow never needs this; tests do. */
  forget(key: string): void {
    const entry = this.frames.get(key);
    if (entry !== undefined && entry.timer !== null) clearTimeout(entry.timer);
    this.frames.delete(key);
  }

  /**
   * THE DECISION, separated from the event so it can be tested with a hostile
   * source and no browser. `source` is whatever the browser said sent the
   * message; `data` is whatever it sent.
   */
  deliver(source: unknown, data: unknown): Verdict {
    // IDENTITY FIRST, PAYLOAD SECOND. An unregistered sender is refused
    // before its data is examined at all, so an unbounded flood from a
    // stranger costs a map walk over the handful of live frames and nothing
    // else. (And see property 1: `event.origin` is "null" for every one of
    // these and is therefore never consulted.)
    let entry: Entry | undefined;
    for (const e of this.frames.values()) {
      if (source !== null && source !== undefined && e.el != null && source === e.el.contentWindow) {
        entry = e;
        break;
      }
    }
    if (entry === undefined) return "unknown-source";

    const report = parseReport(data);
    if (report === null) return "malformed";

    if (entry.state.errors.length >= REPORT_CAP) {
      const suppressed = entry.state.suppressed + 1;
      entry.state = { errors: entry.state.errors, suppressed };
      // CROSSING THE CAP IS ITSELF NEWS, and it is delivered at once: the
      // reader learns that errors are being held back in the same frame it
      // starts happening. Only the COUNT after that is throttled, and the
      // trailing flush makes the last number exact.
      if (suppressed === 1) this.emit(entry);
      else this.emitThrottled(entry);
      return "suppressed";
    }

    const error: ArtifactRuntimeError = {
      kind: report.kind,
      name: report.name,
      message: report.message,
      line: toArtifactLine(report.line),
      column: report.line === null ? null : report.column,
      at: Date.now(),
    };
    entry.state = {
      errors: [...entry.state.errors, error],
      suppressed: entry.state.suppressed,
    };
    this.emit(entry);
    return "accepted";
  }

  /** Install THE listener, once. Nothing listens until a frame is watched. */
  private install(): void {
    if (this.bound !== null || this.target === null) return;
    this.bound = (e: MessageEvent) => {
      this.deliver(e.source, e.data);
    };
    this.target.addEventListener("message", this.bound);
  }

  /** Only for tests: take the listener back off the window. */
  uninstall(): void {
    if (this.bound === null || this.target === null) return;
    this.target.removeEventListener("message", this.bound);
    this.bound = null;
  }

  /** True when the one listener is currently attached. */
  get installed(): boolean {
    return this.bound !== null;
  }

  private emit(entry: Entry): void {
    entry.lastNotify = Date.now();
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    for (const fn of entry.listeners) fn(entry.state);
  }

  /**
   * Past the cap, tell subscribers at most every `SUPPRESS_NOTIFY_MS` — but
   * ALWAYS schedule a trailing flush, so when the flood stops the last number
   * on screen is the true one rather than whatever the throttle happened to
   * land on. A throttle without the trailing edge would round a real count
   * down, which is the fabrication this whole module exists to avoid.
   */
  private emitThrottled(entry: Entry): void {
    const now = Date.now();
    if (now - entry.lastNotify >= SUPPRESS_NOTIFY_MS) {
      this.emit(entry);
      return;
    }
    if (entry.timer !== null) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this.emit(entry);
    }, SUPPRESS_NOTIFY_MS);
  }
}

/** The cockpit's channel. One per document. */
export const artifactErrors = new ArtifactErrorChannel();

// ── Saying it ────────────────────────────────────────────────────────────

/**
 * One runtime failure in the reader's words, in the SAME register as the
 * parse refusal the server writes ("at line 12 of the document").
 *
 * When the browser withheld the location — a rejected promise carries none,
 * and neither does an error a script muted — that is SAID, not filled in.
 */
export function sayError(e: ArtifactRuntimeError): string {
  const head = e.name.length > 0 && !e.message.startsWith(e.name)
    ? `${e.name}: ${e.message}`
    : e.message;
  const body = head.trim().length > 0 ? head : e.name || "an error with no message";
  if (e.line === null) {
    return `${body} — the browser reported no location`;
  }
  const where = e.column === null
    ? `at line ${e.line} of the document`
    : `at line ${e.line}, column ${e.column} of the document`;
  return `${body} — ${where}`;
}

/** The one-line headline for a frame that rendered and then threw. */
export function sayFault(state: ArtifactErrorState): string {
  const n = state.errors.length + state.suppressed;
  const kinds = state.errors.every((e) => e.kind === "unhandledrejection")
    ? "rejected a promise nothing caught"
    : "threw";
  return n === 1
    ? `this artifact rendered, then ${kinds}`
    : `this artifact rendered, then ${kinds} — ${n} times`;
}

/** The honest sentence for what the cap held back. Empty when it held nothing. */
export function saySuppressed(state: ArtifactErrorState): string {
  if (state.suppressed <= 0) return "";
  return state.suppressed === 1
    ? "1 further error was reported and is not shown"
    : `${state.suppressed} further errors were reported and are not shown`;
}
