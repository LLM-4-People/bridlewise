/**
 * ARTIFACT CHECK — the single owner of "can this artifact actually run, and
 * what is it reaching for that the sandbox does not have".
 *
 * WHY THIS EXISTS, measured rather than assumed.
 *
 * Twelve artifacts were driven end-to-end through a real model and rendered
 * in a real sandboxed frame. THREE of them — including the largest and most
 * ambitious (a 55,096-byte Tetris) — died on a JavaScript SyntaxError the
 * moment the frame parsed them. In every one of those three cases
 * `create_artifact` had already answered the model with
 *
 *     {"ok":true, … "message":"Artifact 'X' created. It renders live in the
 *      chat below."}
 *
 * which was not true. The user got a dead rectangle and the model got a
 * success, so the retry protocol the harness already has — a failed tool
 * result is fed back into the conversation and the model tries again — never
 * engaged. The tool was lying, and the lie is what made the failure silent.
 *
 * The failures were not exotic. They were an unescaped apostrophe inside a
 * single-quoted string (`'Empty — host didn't seed it'`), a Python-style `#`
 * comment banner emitted into a JavaScript block, and a missing comma. All
 * three are exactly what a parser catches in microseconds.
 *
 * ── WHAT IS CHECKED, AND WHY IT IS HONEST ─────────────────────────────────
 *
 * The server does not simulate a browser and does not guess. It runs the
 * SAME V8 parser the browser will run, over the same script text, via
 * `node:vm`. A `SyntaxError` here is the error the frame is going to raise —
 * verified: the three broken artifacts produced byte-identical messages from
 * `new vm.Script(...)` and from Chrome ("Invalid or unexpected token",
 * "missing ) after argument list", "Unexpected identifier
 * 'updateIntervalMs'").
 *
 * Only what can be PROVEN is claimed:
 *   - a classic script that fails to compile is a BLOCKING fault. It cannot
 *     run, in any browser, ever.
 *   - a `type="module"` script is NOT compiled here (a module needs a module
 *     goal that `vm.Script` cannot give it) and is reported as skipped
 *     rather than passed. Saying "checked" of something not checked is the
 *     same class of lie this module exists to remove.
 *   - a non-JavaScript `<script type=…>` block (JSON, a template) is not
 *     JavaScript and is skipped.
 *   - an unbalanced `<script>` is a blocking fault: the document was cut off
 *     mid-script, which is what a model running out of output budget
 *     produces.
 *
 * Runtime behaviour is NOT claimed. A well-formed artifact that throws on
 * line 1 at runtime still reports as runnable, because "it compiles" is all
 * that was measured.
 *
 * ── THE CAPABILITY TABLE ──────────────────────────────────────────────────
 *
 * `SANDBOX_CAPABILITIES` is the measured list of what an artifact can and
 * cannot do inside `sandbox="allow-scripts"` + the shared CSP. Every entry
 * was probed in the real frame, not read off a spec — see the notes on each.
 * It is the ONE owner: the tool description the model reads is generated
 * from it, and the warning text is generated from it, so the model can never
 * be told one thing and measured against another.
 *
 * Reaching for a denied capability is a WARNING, not a fault, and the
 * distinction is deliberate. `localStorage` is denied — an unguarded read
 * throws SecurityError and kills the rest of the script, which is exactly
 * how one battle-test game ("Neon Striker") rendered a perfect title screen
 * attached to a dead engine. But a `try/catch` around it is legitimate and
 * one artifact in the same run did precisely that and worked. Static text
 * cannot tell those apart, so the honest move is to TELL the model what the
 * sandbox denies and let it decide — not to reject working code.
 */

import { Script } from "node:vm";

// ── The measured capability table ────────────────────────────────────────

/**
 * One capability an artifact might reach for, with what was MEASURED when it
 * was probed inside the real sandbox (`sandbox="allow-scripts"`, no
 * `allow-same-origin`, plus the shared CSP from `html-preview.ts`).
 *
 * `probe` records how the answer was obtained. It is kept in the data rather
 * than in a comment because this table is the source the model's tool
 * description is generated from, and a claim the model acts on should carry
 * its evidence.
 */
export type SandboxCapability = Readonly<{
  /** The identifier an artifact would use. */
  readonly name: string;
  /** A word-boundary pattern that finds a use of it in script source. */
  readonly pattern: RegExp;
  /** What actually happens, measured. */
  readonly measured: string;
  /** What the artifact should do instead. */
  readonly instead: string;
}>;

/**
 * What the sandbox DENIES. Every line was probed in a live frame; the
 * `measured` string is the observed result, quoted.
 */
export const DENIED_CAPABILITIES: readonly SandboxCapability[] = Object.freeze([
  Object.freeze({
    name: "localStorage",
    pattern: /\blocalStorage\b/,
    measured: "throws SecurityError: the document is sandboxed and lacks the 'allow-same-origin' flag",
    instead: "keep state in a plain JavaScript variable, or wrap every access in try/catch",
  }),
  Object.freeze({
    name: "sessionStorage",
    pattern: /\bsessionStorage\b/,
    measured: "throws SecurityError: the document is sandboxed and lacks the 'allow-same-origin' flag",
    instead: "keep state in a plain JavaScript variable, or wrap every access in try/catch",
  }),
  Object.freeze({
    name: "document.cookie",
    pattern: /\bdocument\s*\.\s*cookie\b/,
    measured: "throws SecurityError on set; the document is sandboxed",
    instead: "keep state in a plain JavaScript variable",
  }),
  Object.freeze({
    name: "indexedDB",
    pattern: /\bindexedDB\b/,
    measured: "indexedDB.open() throws SecurityError: access is denied in this context",
    instead: "keep state in a plain JavaScript variable",
  }),
  Object.freeze({
    name: "fetch",
    pattern: /\bfetch\s*\(/,
    measured: "blocked by the frame's Content-Security-Policy (connect-src 'none') — the request never leaves",
    instead: "embed the data you need directly in the artifact; the frame has no network at all",
  }),
  Object.freeze({
    name: "XMLHttpRequest",
    pattern: /\bXMLHttpRequest\b/,
    measured: "blocked by the frame's Content-Security-Policy (connect-src 'none')",
    instead: "embed the data you need directly in the artifact",
  }),
  Object.freeze({
    name: "WebSocket",
    pattern: /\bWebSocket\b/,
    measured: "blocked by the frame's Content-Security-Policy (connect-src 'none')",
    instead: "embed the data you need directly in the artifact",
  }),
  Object.freeze({
    name: "window.open",
    pattern: /\bwindow\s*\.\s*open\s*\(/,
    measured: "returns null — popups are blocked by the sandbox",
    instead: "render the destination inside the artifact itself",
  }),
  Object.freeze({
    // NAMED PRECISELY. `window.parent` itself resolves, and `postMessage` on
    // it is not blockable by any sandbox — what throws is reaching for the
    // host's DOM or its location. Saying "window.parent is unavailable" would
    // be a claim wider than what was measured.
    name: "window.parent.document / window.top.location",
    pattern: /\b(?:window\s*\.\s*)?(?:parent|top)\s*\.\s*(?:document|location)\b/,
    measured: "throws SecurityError — the host page's DOM and location are unreachable by design",
    instead: "the artifact cannot see or change the page around it; build it self-contained",
  }),
]);

/**
 * What the sandbox ALLOWS. Probed the same way, and listed for the model so
 * it reaches CONFIDENTLY for what is actually there instead of avoiding it
 * or working around a restriction that does not exist.
 */
export const ALLOWED_CAPABILITIES: readonly string[] = Object.freeze([
  "inline <style> and <script> (both run normally)",
  "canvas 2D and WebGL",
  "requestAnimationFrame animation loops",
  "keyboard, mouse, touch and pointer events",
  "Web Audio (AudioContext starts suspended — resume it from a user gesture)",
  "crypto.getRandomValues",
  "data: and blob: URLs, including inline SVG and Web Workers built from a blob",
  "in-memory state for the lifetime of the frame",
]);

/**
 * The sandbox contract in the words the MODEL reads, generated from the two
 * tables above so the tool description cannot drift from what the warnings
 * measure. Used by the `create_artifact` manifest entry.
 */
export function sandboxContractSentence(): string {
  const denied = DENIED_CAPABILITIES.map((c) => c.name).join(", ");
  return (
    `The frame runs with sandbox="allow-scripts" and a strict CSP. AVAILABLE: ${ALLOWED_CAPABILITIES.join("; ")}. ` +
    `NOT AVAILABLE (each one is blocked at runtime — using it throws or silently does nothing): ${denied}, and any external resource by URL ` +
    `(no CDN scripts, stylesheets, fonts or remote images — inline everything or use a data: URI). ` +
    `There is no network and no persistent storage of any kind: state lives in memory for as long as the frame is open.`
  );
}

// ── Faults and warnings ──────────────────────────────────────────────────

export type ArtifactFault = Readonly<{
  /** Which proof failed. */
  readonly kind: "script_syntax" | "unterminated_script";
  /** The message a human (and the model) should act on. */
  readonly message: string;
}>;

export type ArtifactWarning = Readonly<{
  readonly capability: string;
  readonly message: string;
}>;

export type ArtifactCheck = Readonly<{
  /** Blocking: the artifact provably cannot run. */
  readonly faults: readonly ArtifactFault[];
  /** Non-blocking: it will run, but it reaches for something denied. */
  readonly warnings: readonly ArtifactWarning[];
  /** How many script blocks were actually compiled. */
  readonly scriptsChecked: number;
  /** How many were NOT compiled (module goal / non-JavaScript type). */
  readonly scriptsSkipped: number;
}>;

// ── Script extraction ────────────────────────────────────────────────────

type ScriptBlock = Readonly<{
  /** The script's inner source. */
  readonly code: string;
  /** 1-based line in the artifact where the inner source starts. */
  readonly startLine: number;
  /** Why it was skipped, or null when it is compilable classic JavaScript. */
  readonly skipReason: string | null;
}>;

/**
 * A `type=` that means "this is classic JavaScript". An ABSENT type means
 * classic too (the HTML default). Anything else — `module`, `importmap`,
 * `application/json`, `text/x-template` — is either a different goal or not
 * JavaScript, and is skipped rather than mis-parsed.
 */
const CLASSIC_TYPES: ReadonlySet<string> = new Set([
  "",
  "text/javascript",
  "application/javascript",
  "text/ecmascript",
  "application/ecmascript",
]);

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

/** Read the `type` attribute out of a raw attribute string, lowercased. */
function typeAttr(attrs: string): string {
  const m = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
  const raw = m === null ? "" : (m[1] ?? m[2] ?? m[3] ?? "");
  return raw.trim().toLowerCase();
}

/**
 * Every `<script>` block in the document, with the line it starts on so a
 * parser error can be reported against the ARTIFACT's line numbers rather
 * than against the script's own.
 */
export function extractScripts(html: string): readonly ScriptBlock[] {
  const out: ScriptBlock[] = [];
  SCRIPT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SCRIPT_RE.exec(html)) !== null) {
    const attrs = m[1] ?? "";
    const code = m[2] ?? "";
    const t = typeAttr(attrs);
    const innerStart = m.index + m[0].indexOf(">") + 1;
    const startLine = html.slice(0, innerStart).split("\n").length;
    let skipReason: string | null = null;
    if (t === "module") {
      skipReason = "type=module — a module goal cannot be compiled here, so it was not checked";
    } else if (!CLASSIC_TYPES.has(t)) {
      skipReason = `type=${t} — not JavaScript, so it was not checked`;
    }
    out.push(Object.freeze({ code, startLine, skipReason }));
  }
  return Object.freeze(out);
}

/**
 * `<script>` opens and `</script>` closes must balance. They will not when a
 * model runs out of output budget mid-document, which is the failure mode a
 * deliberately maximal prompt produces. Reported as a fault because a
 * document cut off inside a script cannot run the rest of that script.
 */
function unterminatedScriptFault(html: string): ArtifactFault | null {
  const opens = (html.match(/<script\b/gi) ?? []).length;
  const closes = (html.match(/<\/script\s*>/gi) ?? []).length;
  if (opens <= closes) return null;
  return Object.freeze({
    kind: "unterminated_script" as const,
    message:
      `the document has ${opens} <script> opening tag${opens === 1 ? "" : "s"} but only ${closes} closing tag${closes === 1 ? "" : "s"} — ` +
      `it looks cut off mid-script. Send a complete document; if it is too long, build a smaller version.`,
  });
}

// ── The compile check ────────────────────────────────────────────────────

/**
 * Compile ONE classic script with the same engine the browser uses. Returns
 * the fault, or null when it compiles. The reported line is the ARTIFACT's
 * line, and the offending source line is quoted so the model can see what it
 * wrote without re-deriving it.
 */
function compileFault(block: ScriptBlock, index: number): ArtifactFault | null {
  try {
    // `new Script` PARSES eagerly and never executes. Nothing in the
    // artifact runs on the server.
    new Script(block.code, { filename: `artifact-script-${index}.js` });
    return null;
  } catch (err) {
    if (!(err instanceof SyntaxError)) {
      // Anything that is not a SyntaxError is not a claim we can make about
      // the artifact — say what happened and do not dress it up.
      return Object.freeze({
        kind: "script_syntax" as const,
        message: `script #${index} could not be parsed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    // V8 puts the offending line + a caret in the stack preamble; the line
    // number is on the first frame. Both are read defensively — a missing
    // detail means a shorter message, never a fabricated position.
    const stack = typeof err.stack === "string" ? err.stack : "";
    const lineMatch = /artifact-script-\d+\.js:(\d+)/.exec(stack);
    const scriptLine = lineMatch === null ? null : Number(lineMatch[1]);
    const artifactLine = scriptLine === null ? null : block.startLine + scriptLine - 1;
    const sourceLine = scriptLine === null ? null : (block.code.split("\n")[scriptLine - 1] ?? null);
    const where = artifactLine === null ? "" : ` at line ${artifactLine} of the document`;
    const quoted = sourceLine === null ? "" : `\n    ${sourceLine.trim().slice(0, 200)}`;
    return Object.freeze({
      kind: "script_syntax" as const,
      message: `JavaScript syntax error${where}: ${err.message}${quoted}`,
    });
  }
}

// ── The public check ─────────────────────────────────────────────────────

/**
 * Check an artifact document. Pure and synchronous: it parses, it never
 * executes, and it never reaches the network or the filesystem.
 *
 * A non-empty `faults` means the artifact provably cannot run and the tool
 * must fail so the model is told and can retry. `warnings` means it will run
 * but reaches for something the sandbox denies.
 */
export function checkArtifactHtml(content: string): ArtifactCheck {
  const faults: ArtifactFault[] = [];
  const warnings: ArtifactWarning[] = [];

  const unterminated = unterminatedScriptFault(content);
  if (unterminated !== null) faults.push(unterminated);

  const blocks = extractScripts(content);
  let checked = 0;
  let skipped = 0;
  blocks.forEach((block, i) => {
    if (block.skipReason !== null) {
      skipped += 1;
      return;
    }
    checked += 1;
    const fault = compileFault(block, i + 1);
    if (fault !== null) faults.push(fault);
  });

  // The capability scan runs over the SCRIPT SOURCE only — the identifier
  // `localStorage` inside a paragraph of prose in the artifact's own markup
  // is not a use of it.
  const allScript = blocks.map((b) => b.code).join("\n");
  for (const cap of DENIED_CAPABILITIES) {
    if (!cap.pattern.test(allScript)) continue;
    warnings.push(
      Object.freeze({
        capability: cap.name,
        message: `${cap.name} is not available in the artifact sandbox — ${cap.measured}. Instead: ${cap.instead}.`,
      }),
    );
  }

  return Object.freeze({
    faults: Object.freeze(faults),
    warnings: Object.freeze(warnings),
    scriptsChecked: checked,
    scriptsSkipped: skipped,
  });
}

/**
 * The failure message handed back to the MODEL when an artifact cannot run.
 * Written as an instruction because the tool result IS the retry protocol:
 * it is appended to the conversation and the model's next turn is a response
 * to it. A message that only says "invalid" wastes that turn.
 */
export function faultMessage(title: string, check: ArtifactCheck): string {
  const lines = check.faults.map((f) => `  - ${f.message}`);
  return (
    `Error: the artifact '${title}' was NOT created — it cannot run as written.\n` +
    `${lines.join("\n")}\n` +
    `Fix the error above and call create_artifact again with the corrected document. ` +
    `Nothing was shown to the user.`
  );
}
