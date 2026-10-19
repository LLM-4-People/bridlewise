/**
 * THE SERVED-SCOPE PROBE — refuses a dev server that serves a component's CSS
 * UNSCOPED.
 *
 * ── THE DEFECT THIS CLOSES (DESK-CSS-1) ───────────────────────────────────
 *
 * A stale vite-plugin-svelte hot-update served `Desk.svelte`'s `.bar` rule
 * UNSCOPED — no `.svelte-` hash — and `--monitor-w: 96px` leaked onto the
 * desk composer, crushing it to 96px. The Svelte COMPILER scopes correctly
 * (verified by direct `compile()`); the test suite never runs the dev server;
 * so "served unscoped" had no tripwire. Only a user report caught it.
 *
 * This is the class: a component's scoped rule that ever reaches the browser
 * bare lands on EVERY same-named class in the app. The compiler is not the
 * surface that failed — the SERVED module is — so the probe reads the served
 * module, not the compiler.
 *
 * ── WHAT "SERVED UNSCOPED" LOOKS LIKE ─────────────────────────────────────
 *
 * The dev server answers `Component.svelte?svelte&type=style&lang.css` with
 * a JS module whose `__vite__css` is the component's stylesheet. A CORRECT
 * emission scopes every component selector with the `.svelte-<hash>` class.
 * The defect serves the RAW SOURCE (the whole `.svelte` file, unscoped)
 * instead — so the probe reads the `__vite__css` payload and asks: does any
 * CLASS selector that sets a SIZING declaration lack the scope hash?
 *
 * ── THE RULE, DECIDED AND DOCUMENTED ──────────────────────────────────────
 *
 * A CLASS SELECTOR (`.cls`, optionally with pseudo-classes/elements) that
 * carries a SIZING declaration (`width`, `min-width`, `max-width`, `height`,
 * `min-height`, `max-height`, `flex-basis`, or a custom property `--*` whose
 * name ends in `-w`/`-h`/`-width`/`-height`) and is NOT scoped
 * (`.cls.svelte-<hash>`) is a VIOLATION. Sizing is the leak that crushed the
 * composer, and it is the leak that does the layout damage.
 *
 * A bare class selector that sets NO sizing declaration (`.bar { display:
 * flex }`) is NOT refused by this probe: a non-sizing leak changes paint, not
 * layout, and refusing it would require distinguishing every legitimate
 * `:global()` and reset — a larger rule than the defect needs. That choice is
 * deliberate and stated here so a reader does not "strengthen" it into a
 * false-positive machine. The class being caught is "served unscoped SIZING",
 * not "served unscoped anything".
 *
 * `:global(...)` selectors are Svelte's deliberate escape and are skipped
 * entirely — a rule the author scoped-out on purpose is not the defect.
 * Element selectors (`div { … }`) are scoped by the compiler too, but a bare
 * element rule is not the reported class-collision shape and is out of scope.
 *
 * Everything is split pure (the classifier, fixture-driven in
 * `tests/prevention/svelte-css-scope-probe.test.ts`) from live (the fetch),
 * so the deciding logic is tested without a server.
 *
 * DEPENDENCY-FREE ON PURPOSE: node built-ins only.
 */

/** The properties whose leak does layout damage (the composer-crush class). */
const SIZING_PROPERTIES: readonly string[] = [
  "width",
  "min-width",
  "max-width",
  "height",
  "min-height",
  "max-height",
  "flex-basis",
];

/** A custom property whose name declares a size (`--monitor-w`, `--desk-h`). */
const SIZING_CUSTOM_PROPERTY = /--[\w-]*(?:-[wh]|-width|-height)\b/;

/**
 * The scope hash a correctly-compiled component rule carries. Svelte 5 emits
 * `.svelte-<base36>`; the probe accepts the class appearing ANYWHERE in the
 * selector (`.bar.svelte-x`, `.svelte-x .bar`, `.bar.svelte-x:hover`).
 */
const SCOPE_HASH = /\.svelte-[a-z0-9]+/;

export interface UnscopedSizingViolation {
  /** The offending selector, trimmed. */
  readonly selector: string;
  /** The sizing declaration that makes it a violation. */
  readonly declaration: string;
}

/**
 * THE CLASSIFIER, pure over the CSS text. Returns every unscoped class
 * selector that sets a sizing declaration. Empty is clean.
 *
 * Works rule-by-rule: split on `}` to get `selector { declarations` chunks,
 * skip `:global()` selectors and at-rules (`@media` bodies are re-entered by
 * the same split because a nested `.cls{…}` still produces its own chunk),
 * then judge each selector that names a class.
 */
export function findUnscopedSizingSelectors(css: string): UnscopedSizingViolation[] {
  const out: UnscopedSizingViolation[] = [];
  // Strip CSS block comments FIRST: a comment that itself contains `}` or `{`
  // (§-prose does) would otherwise split a rule mid-comment and turn the
  // comment's tail into a phantom "selector" carrying the next declaration.
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  // `selector { declarations` chunks. A `@media … {` chunk has no `{`-opened
  // declaration block of its own in this split; the nested rule inside it
  // yields its own chunk, so nested component rules are still judged.
  for (const chunk of clean.split("}")) {
    const open = chunk.lastIndexOf("{");
    if (open === -1) continue;
    let selector = chunk.slice(0, open).trim();
    const declarations = chunk.slice(open + 1);
    if (selector.length === 0) continue;
    // Svelte's deliberate escape is not the defect.
    if (selector.includes(":global(")) continue;
    // A rule nested in `@media (…) { … }` reaches this split as
    // `@media (…) { .bar { …` — the at-rule header rides the nested rule's
    // chunk. Strip every leading at-rule header so the nested selector is
    // judged on its own; an at-rule header alone (`@media (…)` with no rule)
    // then has no class to judge and falls through.
    while (selector.startsWith("@")) {
      const brace = selector.indexOf("{");
      if (brace === -1) {
        selector = "";
        break;
      }
      selector = selector.slice(brace + 1).trim();
    }
    if (selector.length === 0) continue;
    // Does ANY complex selector in the list name a class without the hash?
    // A selector list (`a, b`) is judged per member — one unscoped sizing
    // member is a violation even if its sibling is scoped.
    for (const member of selector.split(",")) {
      const sel = member.trim();
      if (!sel.includes(".")) continue; // no class selector
      if (SCOPE_HASH.test(sel)) continue; // correctly scoped
      // A class selector with no scope hash: judge what it DECLARES.
      for (const declaration of declarations.split(";")) {
        const prop = declaration.split(":")[0]?.trim() ?? "";
        if (prop.length === 0) continue;
        const isSizing =
          SIZING_PROPERTIES.includes(prop) ||
          (prop.startsWith("--") && SIZING_CUSTOM_PROPERTY.test(prop));
        if (isSizing) {
          out.push({ selector: sel, declaration: prop });
          break; // one sizing declaration is enough to indict the selector
        }
      }
    }
  }
  return out;
}

/**
 * THE VERDICT, pure. Given the served style-module's CSS payload and the
 * component it claims to be, returns the refusal line or `null` (clean).
 */
export function unscopedCssVerdict(
  componentPath: string,
  violations: readonly UnscopedSizingViolation[],
): string | null {
  if (violations.length === 0) return null;
  const lines = violations.map(
    (v) => `${v.selector} { … ${v.declaration}: … }`,
  );
  return (
    `${componentPath} was served with UNSCOPED sizing CSS — a scoped rule reached the ` +
    `browser bare: ${lines.join("; ")}. A bare .cls rule lands on every same-named class ` +
    `in the app (this is the leak that crushed the desk composer to 96px). The Svelte ` +
    `compiler scopes correctly; this is the dev server serving a stale hot-update. ` +
    `Restart the dev server (node scripts/sd.mjs restart) and re-run.`
  );
}

/**
 * Extract the CSS payload from a served `?svelte&type=style` module. The dev
 * server wraps the stylesheet in `const __vite__css = "<escaped>";` — this
 * unwraps the JS string literal. Returns `null` when the module does not
 * carry a style payload (absent, reported NOT JUDGED by the caller).
 */
export function extractServedCss(styleModuleSource: string): string | null {
  const marker = "__vite__css = ";
  const at = styleModuleSource.indexOf(marker);
  if (at === -1) return null;
  const start = styleModuleSource.indexOf('"', at + marker.length);
  if (start === -1) return null;
  // The payload is a single JSON-encoded string literal; decode it with the
  // same parser the runtime uses rather than a hand-rolled un-escaper.
  let end = start + 1;
  while (end < styleModuleSource.length) {
    if (styleModuleSource[end] === "\\") {
      end += 2;
      continue;
    }
    if (styleModuleSource[end] === '"') break;
    end += 1;
  }
  const literal = styleModuleSource.slice(start, end + 1);
  try {
    const decoded: unknown = JSON.parse(literal);
    return typeof decoded === "string" ? decoded : null;
  } catch {
    return null;
  }
}
