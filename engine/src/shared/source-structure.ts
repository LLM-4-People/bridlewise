/**
 * STRUCTURAL SCOPES FOR SOURCE ASSERTIONS — the shared owner that makes a
 * PROXIMITY WINDOW unexpressible.
 *
 * ── THE CLASS THIS EXISTS TO REMOVE ───────────────────────────────────────
 *
 * A guard that wants to say "`runGitConfined` goes through `gitText`" has been
 * saying it like this:
 *
 *   expect(read("server/git-bridge.ts"))
 *     .toMatch(/export function runGitConfined … {0,600}? … return gitText\(/);
 *
 * That is not the claim. It is the GUESS that two things are related because
 * they are near each other in a file, and the guess is wrong whenever a
 * neighbour is nearer than the window is wide. Measured on that exact line:
 * the function's own `return gitText(` sits 344 bytes after the anchor and the
 * NEXT function's sits at 584, sixteen bytes inside a 600-byte window. With
 * `runGitConfined`'s body replaced by a raw unconfined spawn, the assertion
 * still returned true.
 *
 * A window is only ever an approximation of a structural fact — "inside this
 * function's body", "inside this CSS rule" — and this module supplies the
 * structural fact.
 *
 * ── WHY THE FIRST ATTEMPT AT THIS MODULE WAS WRONG 212 TIMES ──────────────
 *
 * The first version walked the signature character by character and balanced
 * braces to find the body. All sixteen call sites it converted were correct,
 * so the suite was green; driven over every named function in both production
 * trees and differentiated against a real parser, it returned the WRONG REGION
 * for 212 of 6,512 names and refused 309 more that do have bodies. Three
 * causes, each a variation on the same theme:
 *
 *   - a union return type ending in a string literal (`): "exact" | "prefix" {`)
 *     made the real body look like a type position, so the NEXT FUNCTION'S BODY
 *     was returned — the proximity-neighbour defect, reproduced inside the
 *     module written to remove it, now wearing a structural disguise;
 *   - an interface member `f: (x) => T;` is indistinguishable from an
 *     expression-bodied arrow by inspection, so the RETURN TYPE came back as
 *     the body (`"Buffer"`, `"void"`);
 *   - an expression body ran past the `,` that ends it, so a one-line object's
 *     arrow swallowed its neighbour.
 *
 * BRACE-MATCHING A SIGNATURE IS NOT PARSING, and the answer is not a better
 * brace-matcher. It is to ask the instrument that already had to be correct:
 * this workspace already parses TypeScript with `@babel/parser` in six
 * production modules, through the shared AST helpers, so "where does this
 * function's body begin and end" is answered by the same parser that answers it
 * for the quality packs. The acceptance test is a differential against a SECOND
 * independent parser (TypeScript's own) over every named function in both
 * production trees, and it must disagree zero times.
 *
 * ── WHY THE SECOND ATTEMPT WAS ALSO WRONG, AND WHAT REPLACED IT ───────────
 *
 * The second version kept a door that accepted a `RegExp` — `bodyMatches` —
 * and put a DETECTOR in front of it that decided whether the pattern bounded a
 * distance. The first detector knew four spellings and admitted six. The
 * second ran the pattern's atoms against a forty-character probe alphabet, and
 * admitted three more: `[^￿]{0,600}` (which excludes exactly the last probe),
 * `\p{Any}{0,600}` and `(?:[\s\S][\s\S][\s\S]){0,200}`. The published test's
 * own twentieth spelling, `[^￰]{0,600}`, sits ONE CODE POINT from the hole.
 *
 * That is the same universe defect, living inside the instrument built to
 * escape universe defects: A PROBE-BASED DETECTOR IS ONLY AS COMPLETE AS ITS
 * PROBE ALPHABET, and an alphabet is a list. The class was declared closed
 * twice by making the list better.
 *
 * SO THE DOOR IS GONE. There is no longer anything in this module that accepts
 * a `RegExp`. Every door takes NAMES — {@link bodyCalls}, {@link bodyCallsWith},
 * {@link bodyBinds}, {@link bodyReturns}, {@link cssDeclares},
 * {@link attributeOf}, {@link objectLiteralsWith} — and {@link bodySays} takes
 * a plain string matched by containment, which has no wildcard to write. A
 * proximity window is not refused here; it is UNSAYABLE THROUGH A DOOR. With no
 * pattern parameter there is nothing to detect, and with nothing to detect
 * there is no alphabet to be incomplete.
 *
 * THE PRECISE CLAIM, because the loose one will be quoted downstream:
 * {@link SourceScope.body} is a public `string`, and several doors hand back
 * raw text. A caller can still write
 * `expect(functionBody(src, "f").body).toMatch(/a[\s\S]{0,600}b/)` and nothing
 * here objects. What has been removed is the PARAMETER a window fits in — the
 * window is at least bounded by the construct now, which is a real improvement
 * and is not the same as the class being gone. The rung-3 form of the rule ("a
 * guard may not apply a pattern to UNSCOPED source") is an estate-wide change
 * recorded as its own task. That no converted site does this today is a fact
 * about today's callers, not a property of the design.
 *
 * ── THE LADDER, and where each rung is genuinely available ────────────────
 *
 *   1. Physically impossible — NOT reachable. A regular expression literal is
 *      data the language will always accept; no engine refuses a wildcard gap,
 *      and nothing can stop a guard writing one over text it read itself.
 *   2. Unrepresentable — REACHED, and this is the rung that matters. No door in
 *      this module has a parameter a pattern fits in. The commonest claim,
 *      "A calls B", is {@link bodyCalls}: two identifiers, answered from the
 *      CALL GRAPH, so a callee named only in a comment does not satisfy it. The
 *      claims that used to need a pattern each became a door that takes names,
 *      and every one of them is STRICTER than the pattern it replaced —
 *      `bodyCallsWith(scope, "detectSecretSpans", ["text", "policy", "options"])`
 *      compares arguments the parser delimited, where `[^)]*` stopped at the
 *      first `)` inside a nested call.
 *   3. Unreachable by shape — REACHED BY THE COMPILER in this repository and at
 *      runtime in the web repository, and the difference is measured rather
 *      than assumed. {@link SourceScope} is branded with a MODULE-PRIVATE
 *      `unique symbol`, so no other module can even name the property: in the
 *      1,114-file harness program (of which 444 files are under `test/`) a
 *      guard that hands whole-file text to a door does not compile. The web
 *      suite's `tests/**` is in none of that repository's three tsconfig
 *      programs, so the same brand there would be documentation — which is why
 *      identity is ALSO held in a module-private `WeakSet` that only this
 *      module writes to. An earlier version used `Symbol.for(…)` — the GLOBAL
 *      registry, with the key written in this file — so a caller could mint a
 *      scope in one line and pass whole-file source through the door built to
 *      stop exactly that.
 *   4. Runtime choke point — NO LONGER NEEDED FOR THIS CLASS, which is the
 *      point of rung 2 and not an omission. There is no pattern arriving at a
 *      door, so there is no pattern to judge. The refusals that remain here are
 *      about SUBJECTS rather than patterns: a name that is absent, a name that
 *      is declared twice, a value that does not parse.
 *   5. A source-scan guard over both repositories' test trees, because nothing
 *      above can reach a NEW test that never imports this module and writes its
 *      own `expect(wholeFile).toMatch(…)`. That guard is
 *      `no-proximity-window-assertions.test.ts` in the web repository, and it
 *      consumes {@link windowGapIn} from here rather than carrying a second
 *      copy of the detector. IT IS THE ONE PLACE AN ALPHABET STILL LIVES, its
 *      three known escapes are driven as a permanent test, and the rung-3 form
 *      of that rule — a guard may not run a pattern over unscoped source at all
 *      — is recorded as its own task rather than pretended at.
 *
 * ── WHY IT LIVES IN THE HARNESS AND NOT IN ONE SUITE'S HELPERS ────────────
 *
 * The question "what is inside this construct" depends on nothing about either
 * product, so it is agnostic and has one home. The web suite re-exports it
 * through `tests/helpers/function-scope.ts`, which is that suite's one door to
 * shared test primitives.
 */
import { parse } from "@babel/parser";

import { InputError } from "../kernel/errors.ts";
import { astNode, astNodeArray, walkAst, type AstNode } from "../quality-packs/prevention/ast-helpers.ts";

/**
 * The compile-time half of the brand. MODULE-PRIVATE on purpose: a `unique
 * symbol` no other module can name is a property no other module can write, so
 * in any program that type-checks this file — the harness's own, whose 1,114
 * files include its 444 test files — constructing a {@link SourceScope} by hand
 * is a compile error rather than a convention.
 */
declare const SCOPE_BRAND: unique symbol;

/**
 * The runtime half. The web suite's tests are in none of that repository's
 * tsconfig programs, so a type-level brand alone would be documentation there.
 * A `WeakSet` this module alone writes to cannot be forged from outside at all:
 * there is no key to guess and no registry to look the value up in.
 */
const ISSUED_SCOPES = new WeakSet<object>();

/**
 * WHAT THE PARSER SAW INSIDE ONE SCOPE — the whole vocabulary the doors answer
 * from, computed once per scope and never re-derived from the body text.
 *
 * Every field is a set of NAMES or of LITERAL TEXT, and that is the point
 * rather than an implementation detail: a door that answers from this record
 * can only ever be asked about a name, so there is nowhere in this module's
 * surface to put a wildcard. The previous design answered one door from a
 * `RegExp` and spent two rounds trying to decide which patterns were honest.
 */
type ScopeFacts = Readonly<{
  /** Callee text of every call, whitespace removed (`db.getProject`). */
  calls: ReadonlySet<string>;
  /** Per callee, the argument-source text of each call to it, in order. */
  callArguments: ReadonlyMap<string, readonly (readonly string[])[]>;
  /** Per bound name, the source text each binding relates it to. */
  bindings: ReadonlyMap<string, ReadonlySet<string>>;
  /** The argument text of every `return`, whitespace removed. */
  returns: ReadonlySet<string>;
  /** The value of every string and template literal, for {@link bodySays}. */
  strings: readonly string[];
}>;

const SCOPE_FACTS = new WeakMap<object, ScopeFacts>();

/**
 * The compile-time half of the SUBJECT brand — see {@link ScopeSubject}.
 * Module-private, so no caller can mint one and no helper outside this file can
 * be handed something that merely looks like one.
 */
declare const SUBJECT_BRAND: unique symbol;

/**
 * THE ONE OBJECT A CODE SCOPE IS ABOUT — its span AND the node its facts are
 * read from, carried together because they are the same thing.
 *
 * ── WHY THIS TYPE EXISTS, AND WHY IT IS NOT A TIDINESS MEASURE ─────────────
 *
 * "The function" and "the function's BODY" are DIFFERENT OBJECTS, and this
 * workspace has now confused them three times in one day, through three
 * different mechanisms:
 *
 *   - a matcher took the next `{` after the name, so `options: Options = {}`
 *     became the body and every assertion about that function became an
 *     assertion about two bytes;
 *   - an extractor took `indexOf("{", afterSignature)`, so a return type spelled
 *     `Readonly<{ … }>` became the body;
 *   - and here, with the span finally correct, the FACTS were still read from
 *     the whole function node — so `commitFilesByHash`, whose body never
 *     mentions `gitText`, answered `bodyCalls(scope, "gitText")` with TRUE
 *     because its signature carries `run: GitRunner = (args) => gitText(…)`.
 *     A guard asserting "this function goes through the confined runner" was
 *     satisfied by a default the caller can override.
 *
 * Three arrivals through three doors means the defect is in the MODEL, not in
 * the three call sites. So there is no longer a call that takes a node and a
 * text and hopes they belong together: {@link scopeFactsIn} takes ONE subject,
 * {@link bodySubjectOf} is the only way to obtain a function's, and it can only
 * ever hand back the body. The span and the facts are derived from the same
 * `node`, so "facts of a wider node" is not a thing that can be written.
 *
 * `from`/`to` are the SPAN OF THE SCOPE, which is not always `node`'s own span:
 * a block body excludes its braces, and a parenthesised expression body
 * includes its parentheses. Both are wider or narrower by delimiters only, so
 * every fact still comes from inside — which is what {@link scopeFactsIn}
 * checks before it hands the facts back.
 */
type ScopeSubject = Readonly<{
  [SUBJECT_BRAND]: true;
  /** The node whose contents ARE the facts. */
  node: AstNode;
  /** The text `node`'s offsets and `from`/`to` are relative to. */
  text: string;
  /** Where the scope's own text begins in `text`. */
  from: number;
  /** Where it ends. */
  to: number;
}>;

/** A region of source that is bounded by SYNTAX rather than by a byte count. */
export type SourceScope = Readonly<{
  [SCOPE_BRAND]: true;
  /** What kind of construct bounds it — for the failure message. */
  kind: "function" | "css-rule" | "element" | "attribute" | "binding";
  /** The name that was asked for. */
  name: string;
  /** The text inside the construct, excluding its delimiters. */
  body: string;
  /** Byte offset of `body` within the source it came from. */
  offset: number;
}>;

function issueScope(
  kind: SourceScope["kind"],
  name: string,
  body: string,
  offset: number,
  facts?: ScopeFacts,
): SourceScope {
  const scope = Object.freeze({ kind, name, body, offset }) as unknown as SourceScope;
  ISSUED_SCOPES.add(scope);
  if (facts !== undefined) SCOPE_FACTS.set(scope, facts);
  return scope;
}

/** The parsed facts of a scope, refusing when the scope carries none. */
function factsOf(scope: SourceScope, door: string): ScopeFacts {
  if (!isSourceScope(scope)) {
    throw new InputError(
      `${door} expects a scope from functionBody()/cssRule()/elementWithAttribute()/attributeOf(), not raw source. `
      + "Asking about a whole file is how a proximity window gets re-introduced: the claim is then bounded by nothing but the file.",
      "source_structure_not_a_scope",
    );
  }
  const facts = SCOPE_FACTS.get(scope);
  if (facts === undefined) {
    throw new InputError(
      `${door} asks what the parser found in this body, and a ${scope.kind} scope has none — it is stylesheet or markup text, not code. `
      + "Ask cssDeclares() about a rule's declarations, or attributeOf() for the code inside an attribute.",
      "source_structure_not_a_scope",
    );
  }
  return facts;
}

/** Is this value a scope produced by this module? */
export function isSourceScope(value: unknown): value is SourceScope {
  return typeof value === "object" && value !== null && ISSUED_SCOPES.has(value);
}

// ── The estate scan's detector — and the honest limit of one ───────────────
//
// EVERYTHING BELOW SERVES RUNG 5 ALONE. There used to be a rung-4 door here as
// well: `bodyMatches` took a `RegExp` and refused the ones that bounded a
// distance. That door is gone, and with it the whole question of "which
// patterns are honest" for anything that goes through this module — the doors
// now take NAMES, so a caller has nowhere to write a gap. See the header.
//
// What remains is the scan over guard source, which is the only thing that can
// reach a test that never imports this module and writes its own
// `expect(wholeFile).toMatch(/a[\s\S]{0,600}b/)`. That scan reads PATTERNS AS
// TEXT, and reading a pattern as text is where the universe problem lives:
//
//   A DETECTOR THAT DECIDES "IS THIS ATOM A GAP" NEEDS A NOTION OF ARBITRARY
//   TEXT, AND THAT NOTION IS AN ALPHABET, AND AN ALPHABET IS A LIST.
//
// This one is a list of forty characters, and it is INCOMPLETE BY
// CONSTRUCTION: `[^￿]` excludes exactly the last probe and is therefore
// not seen as a gap, though it admits every character anybody would ever match.
// Two further shapes escape for lexing reasons rather than alphabet ones —
// `\p{Any}{0,600}` (a Unicode property escape is lexed as `\p` plus a literal
// `{Any}`) and `(?:[\s\S][\s\S][\s\S]){0,200}` (a group that needs three
// characters is tested against single ones). All three are driven as a
// permanent test, so the edge is MEASURED rather than assumed and closing it
// later is a deliberate act rather than an accident.
//
// The structural answer is NOT a longer alphabet — that is the same list one
// round later, and this class has already been declared closed twice that way.
// It is to remove the subject: a guard that reaches for a window is a guard
// applying a pattern to a WHOLE FILE, and the rung-3 form of this rule is "a
// guard may not run a pattern over unscoped source at all". That is an
// estate-wide change to hundreds of call sites and is recorded as its own task
// rather than pretended at here.

/**
 * The probe alphabet. An atom that admits every one of these characters admits
 * ANYTHING, whatever class or group it was spelled with — `[\s\S]`, `[\S\s]`,
 * `[^]`, `[\w\W]`, `[\d\D]`, `(?:.|\n)` and `[\0-￿]` all do. A class that
 * bounds itself on a real token does not: `\s` fails on `a`, `[^}]` fails on
 * `}`, `[0-9a-f]` fails on nearly all of them.
 *
 * Line terminators are held separately because `.` and `[^\n]` admit everything
 * EXCEPT them, and a gap that cannot cross a line is still a gap.
 */
const PROBE_CHARACTERS = [
  "a", "Z", "0", "_", " ", "\t", "{", "}", "(", ")", "[", "]", "\"", "'", "\\",
  "/", "-", ".", ",", ";", ":", "<", ">", "|", "&", "?", "!", "@", "#", "$",
  "%", "^", "~", "*", "+", "=", "`", "\u0000", "é", "￿",
] as const;

/**
 * Does this regular-expression ATOM admit arbitrary text — i.e. is it a GAP
 * rather than a token?
 *
 * Decided by RUNNING it, never by comparing its spelling to a list. That is the
 * whole difference between this detector and the one it replaces: the previous
 * version knew four spellings and admitted six, one of which was the original
 * defect with two characters transposed.
 */
function atomIsGap(atom: string): boolean {
  let anchored;
  try {
    anchored = new RegExp(`^(?:${atom})$`, "u");
  } catch {
    try {
      anchored = new RegExp(`^(?:${atom})$`);
    } catch {
      return false;
    }
  }
  return PROBE_CHARACTERS.every((c) => anchored.test(c));
}

/**
 * The end of the character class opening at `from`, or -1.
 *
 * CLASSES DO NOT NEST: a regular-expression escaper's own class contains a
 * literal `[`, and counting depth reads it as an unclosed class and then
 * mis-lexes the rest of the pattern — measured at eleven false accusations
 * across the two guard trees. Nor is `]` a literal after `[` or `[^`: unlike
 * some dialects, JavaScript closes the class there, which is exactly why `[^]`
 * is the idiomatic "any character" and must be seen as one.
 */
function endOfClass(text: string, from: number): number {
  let i = from + 1;
  if (text[i] === "^") i += 1;
  for (; i < text.length; i += 1) {
    if (text[i] === "\\") { i += 1; continue; }
    if (text[i] === "]") return i + 1;
  }
  return -1;
}

/** The end of the group opening at `from`, or -1. Groups DO nest. */
function endOfGroup(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    const c = text[i]!;
    if (c === "\\") { i += 1; continue; }
    if (c === "[") { const end = endOfClass(text, i); if (end < 0) return -1; i = end - 1; continue; }
    if (c === "(") depth += 1;
    else if (c === ")") { depth -= 1; if (depth === 0) return i + 1; }
  }
  return -1;
}

/**
 * DOES THIS PATTERN FRAGMENT REQUIRE A NAME TO BE MATCHED?
 *
 * ── WHAT THE DELIMITER RULE IS ACTUALLY FOR ───────────────────────────────
 *
 * A lazy run is an honest EXTRACTOR when it stops at a construct's own end —
 * `/\/\*[\s\S]*?\*\//` takes a comment and the `*` `/` is the comment's real
 * terminator. It is a DISTANCE CLAIM when it stops at a NAME, because "some
 * `requireAdminContext` appears somewhere after some `router.put`" is the
 * proximity guess written lazily.
 *
 * So the question is "is there a NAME after the run", and the previous rule
 * asked "does what follows START WITH a word character". That is a list of one
 * character wearing a property's clothes, and eleven shapes walked through it:
 *
 *     \.requireAdminContext\(        an escaped dot
 *     (requireAdminContext)\(        a capture group
 *     (?:requireAdminContext)\(      a non-capturing group
 *     [rR]equireAdminContext\(       a character class
 *     \$\{requireAdminContext\}      an escaped dollar
 *     "requireAdminContext"          a quote
 *     =\s*deepFreeze\(               an equals sign
 *     -->requireAdmin                a multi-character delimiter
 *     (?=requireAdminContext)        a lookahead
 *
 * Every one of them is a name reached through ONE non-word character, and
 * prefixing the module's own headline offender with a single `\.` made it
 * exempt and uncounted. So the rule now LEXES the fragment and asks whether it
 * forces two or more consecutive word characters to be matched — which is what
 * "a name" means, and which no amount of punctuation in front of it changes.
 *
 * Deliberately conservative in one direction: a character class, an
 * alternation, a quantifier and a wildcard all RESET the run rather than
 * contributing to it, so `[rR]equireAdminContext` is still a name (by its
 * eighteen literal characters) while `[a-z]` alone is not. Being wrong here
 * costs a pattern being COUNTED rather than exempted, which is the direction an
 * exemption should fail in.
 */
function requiresAName(text: string): boolean {
  let run = 0;
  const isWord = (c: string): boolean => /[\w]/.test(c);
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (c === "\\") {
      // `\w`, `\d`, `\s`, `\b` and friends match a CLASS, not a literal; every
      // other escape is one literal punctuation character. Neither is a name.
      i += 1;
      run = 0;
      continue;
    }
    if (c === "[") {
      const end = endOfClass(text, i);
      if (end < 0) return run >= 2;
      i = end - 1;
      run = 0;
      continue;
    }
    if (c === "(") {
      // A GROUP IS TRANSPARENT HERE. `(requireAdminContext)` and
      // `(?:requireAdminContext)` require exactly the same name; a lexer that
      // treated the parenthesis as a break would call both of them delimiters.
      const opener = /^\((?:\?(?:<[=!]|[:=!>]|<[A-Za-z_$][\w$]*>))?/.exec(text.slice(i));
      i += (opener?.[0].length ?? 1) - 1;
      continue;
    }
    if (c === ")") continue;
    if (isWord(c)) {
      // A quantifier makes the character it follows optional or repeated, so it
      // is not a character the pattern REQUIRES.
      const quantifier = quantifierAt(text, i + 1);
      if (quantifier !== undefined) { i += quantifier.length; run = 0; continue; }
      run += 1;
      if (run >= 2) return true;
      continue;
    }
    run = 0;
  }
  return false;
}

/** `{n}` / `{n,}` / `{n,m}` / `*` / `+` / `?` at `i`, with its upper bound. */
function quantifierAt(text: string, i: number): Readonly<{ length: number; max: number }> | undefined {
  const c = text[i];
  if (c === "*" || c === "+") return { length: 1, max: Number.POSITIVE_INFINITY };
  if (c === "?") return { length: 1, max: 1 };
  if (c !== "{") return undefined;
  const close = text.indexOf("}", i);
  if (close < 0) return undefined;
  const inside = text.slice(i + 1, close);
  const braced = /^(\d*)(,(\d*))?$/.exec(inside);
  if (braced === null) return undefined;
  const lower = braced[1] === "" ? undefined : Number(braced[1]);
  if (braced[2] === undefined) return lower === undefined ? undefined : { length: close - i + 1, max: lower };
  const upper = braced[3] === undefined || braced[3] === "" ? Number.POSITIVE_INFINITY : Number(braced[3]);
  return { length: close - i + 1, max: upper };
}

/** A wildcard run found in a pattern, with the three facts that judge it. */
export type PatternGap = Readonly<{
  /** The `atom + quantifier` text, for the failure message. */
  text: string;
  /** `{0,600}` and `{600}` are bounded; `*` and `+` are not. */
  bounded: boolean;
  /** A trailing `?` makes it lazy — it stops at the first thing that follows. */
  greedy: boolean;
  /**
   * IS THERE A SECOND ANCHOR AFTER IT? This is what makes a run a DISTANCE
   * CLAIM rather than an extraction, and it is the distinction the previous
   * versions did not draw. A line-comment stripper runs `[^\n]` with a `*`
   * to the end of the line and STOPS there — it takes the rest of the comment,
   * and there is no second thing it claims to be near. The offender puts the
   * same wildcard BETWEEN two anchors — `uncaughtException`, gap,
   * `webConsoleError` — and that is the whole defect: it says those two are
   * related because one appears somewhere after the other.
   */
  anchored: boolean;
  /**
   * IS WHAT FOLLOWS IT A LITERAL DELIMITER?
   *
   * This is what separates the honest extractor from a lazy distance claim,
   * and the distinction is real rather than theoretical. A comment stripper
   * runs lazily to `*` `/` — a delimiter, the construct's own end. But
   * `router\.put\([\s\S]*?requireAdminContext\(` is ALSO a lazy run between two
   * anchors, and it says "some admin check appears after some PUT
   * registration" — the headline defect, written lazily. Measured across the
   * guard estate: of 146 lazy runs with a second anchor, 93 are followed by a
   * delimiter and 53 are not.
   */
  delimited: boolean;
}>;

/**
 * THE SINGLE OWNER OF "does this text contain a wildcard run?" — and it
 * CLASSIFIES rather than judging, because the lexing is a fact and the verdict
 * is a policy. {@link windowGapIn} applies the policy; the scan that has to
 * report the breakdown its exemption rests on reads the classification.
 *
 * It looks for an ATOM immediately followed by a QUANTIFIER and then asks the
 * atom what it admits, by running it. Whitespace between the two is not a
 * quantifier in any dialect, so `a * b` in ordinary source is not a candidate.
 */
function firstGapIn(text: string, restOfOuter = ""): PatternGap | undefined {
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    let atomEnd;
    if (c === "\\") atomEnd = i + 2;
    else if (c === "[") atomEnd = endOfClass(text, i);
    else if (c === "(") atomEnd = endOfGroup(text, i);
    else atomEnd = i + 1;
    if (atomEnd <= i || atomEnd > text.length) { i += 1; continue; }
    const quantifier = quantifierAt(text, atomEnd);
    // A quantifier whose upper bound is one repeats nothing, so it cannot span
    // a gap; `{0,600}`, `{600}`, `*` and `+` all can.
    if (quantifier !== undefined && quantifier.max >= 2 && atomIsGap(text.slice(i, atomEnd))) {
      const after = atomEnd + quantifier.length;
      const lazy = text[after] === "?";
      // What still has to match after the run — including whatever follows the
      // GROUP this run may be nested in, because a second anchor outside the
      // group anchors the run just as firmly as one beside it.
      const follows = text.slice(lazy ? after + 1 : after) + restOfOuter;
      return {
        text: text.slice(i, after),
        bounded: Number.isFinite(quantifier.max),
        greedy: !lazy,
        // `$` asserts a position and consumes nothing, so a run followed only
        // by it is still running to the end of the subject.
        anchored: follows.replace(/\$/g, "").length > 0,
        // NOT A LIST OF DELIMITER CHARACTERS, AND NOT A LIST OF ONE EITHER.
        // The first draft was a list and called `-->` a second anchor because
        // `-` was not in it. The second draft asked whether what follows STARTS
        // WITH a word — which is a list of length one, and eleven shapes walked
        // through it. The property is {@link requiresAName}: a run is DELIMITED
        // when nothing after it forces a NAME to be matched, wherever in the
        // fragment that name sits. `*` `/`, `-->`, `\n}` and a closing quote
        // delimit; `requireAdminContext(`, `\.requireAdminContext(`,
        // `(?:requireAdminContext)` and `=\s*deepFreeze\(` are all anchors.
        delimited: follows.length > 0 && !requiresAName(follows),
      };
    }
    // A GROUP IS NOT OPAQUE. `x([^\n]{0,20})y` puts the gap INSIDE the capture,
    // so a lexer that steps over the group as one atom walks straight past the
    // window — which is how a guard would write one without meaning to.
    if (c === "(") {
      const inside = firstGapIn(text.slice(i + 1, atomEnd - 1), text.slice(atomEnd) + restOfOuter);
      if (inside !== undefined) return inside;
    }
    i = atomEnd;
  }
  return undefined;
}

/**
 * A DISTANCE BOUND BETWEEN TWO ANCHORS, in any spelling this detector can lex.
 *
 * ── WHICH WILDCARD RUNS COUNT, AND WHY THIS IS THE LINE ───────────────────
 *
 * A **bounded** run (`{0,600}`, `{600}`) is a window in every case. The number
 * IS the guess: it says "these two things are related because they are at most
 * six hundred bytes apart", and it is satisfied by whichever neighbour happens
 * to fall inside — measured on the original defect at a margin of sixteen
 * bytes.
 *
 * A **greedy unbounded** run (`[\s\S]*`, `.+`) is the same guess with the
 * number left off, and it counts too. The previous version exempted every
 * unbounded run, on the argument that they are "almost all correct comment
 * strippers" — and that argument was wrong in a way that hid a live offender:
 * three assertions in one guard file spanned the whole of a server entry point
 * with `/uncaughtException[\s\S]*webConsoleError/`, satisfied by ANY
 * `webConsoleError` anywhere after the handler registration. That is this
 * module's headline defect, in a file this scan read and called clean.
 *
 * A **lazy unbounded** run (`[\s\S]*?`, `[^]+?`) does NOT count, and it is the
 * one deliberate exemption. It is how a delimiter-bounded extractor is
 * correctly written — `/\/\*[\s\S]*?\*\//` takes a comment, and the `*` `/`
 * that follows is the construct's real end rather than a guessed distance. The
 * exemption is a CLAIM ABOUT THE WORLD, so the scan reports the breakdown it
 * rests on as a runtime number every run instead of asserting it once in prose;
 * and a lazy run is still refused the moment it is also BOUNDED, because a
 * number reintroduces the guess whatever the laziness.
 *
 * Nothing here knows a spelling by name: `[\s\S]`, `[\S\s]`, `[\w\W]`, `[\d\D]`,
 * `(?:.|\n)`, `[^]`, `.` and `[\0-￿]` are one guess in eight spellings and are
 * all found by RUNNING the atom rather than by reading it. The limits of that
 * are stated at the top of this section and driven as a permanent test.
 */
export function windowGapIn(text: string): string | undefined {
  const gap = firstGapIn(text);
  if (gap === undefined) return undefined;
  // NO SECOND ANCHOR, NO DISTANCE CLAIM. A run with nothing after it takes the
  // rest of the line or the rest of the subject; there is no other thing it
  // asserts to be nearby, so there is no neighbour that can satisfy it.
  if (!gap.anchored) return undefined;
  return gap.bounded || gap.greedy ? gap.text : undefined;
}

/**
 * The classification behind {@link windowGapIn}, for the scan that must REPORT
 * the breakdown its exemption rests on rather than assert it.
 */
export function patternGapIn(text: string): PatternGap | undefined {
  return firstGapIn(text);
}

// ── The parser ────────────────────────────────────────────────────────────

/**
 * Advance past a string, template literal or comment starting at `i`, or return
 * `i` when none starts there.
 *
 * USED ONLY BY THE STYLESHEET AND MARKUP READERS BELOW. TypeScript is not read
 * this way any more and must not be: the previous version's whole defect class
 * came from treating "walk the characters and count the braces" as a substitute
 * for parsing.
 */
function skipLiteral(src: string, i: number): number {
  const c = src[i]!;
  if (c === "/" && src[i + 1] === "/") {
    const nl = src.indexOf("\n", i);
    return nl < 0 ? src.length : nl;
  }
  if (c === "/" && src[i + 1] === "*") {
    const end = src.indexOf("*/", i + 2);
    return end < 0 ? src.length : end + 2;
  }
  if (c === '"' || c === "'" || c === "`") {
    let j = i + 1;
    while (j < src.length) {
      if (src[j] === "\\") { j += 2; continue; }
      if (src[j] === c) return j + 1;
      // A template's `${ … }` may itself contain the quote character.
      if (c === "`" && src[j] === "$" && src[j + 1] === "{") {
        let depth = 1;
        j += 2;
        while (j < src.length && depth > 0) {
          if (src[j] === "{") depth += 1;
          else if (src[j] === "}") depth -= 1;
          else { const skipped = skipLiteral(src, j); if (skipped !== j) { j = skipped; continue; } }
          j += 1;
        }
        continue;
      }
      j += 1;
    }
    return src.length;
  }
  return i;
}

/**
 * The index just past the delimiter matching the one at `from`, or `undefined`
 * when it never closes. Stylesheets and markup only — see {@link skipLiteral}.
 */
function tryBalanceTo(src: string, from: number, open: string, close: string): number | undefined {
  let depth = 0;
  let i = from;
  while (i < src.length) {
    const skipped = skipLiteral(src, i);
    if (skipped !== i) { i = skipped; continue; }
    const c = src[i]!;
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return undefined;
}

/** {@link tryBalanceTo}, refusing instead of answering "there is none". */
function balanceTo(src: string, from: number, open: string, close: string, what: string): number {
  const end = tryBalanceTo(src, from, open, close);
  if (end === undefined) {
    throw new InputError(
      `${what}: a '${open}' opened at ${from} is never closed, so no body could be read`,
      "source_structure_unbalanced",
    );
  }
  return end;
}

// ── The script reader: one parser, no hand-rolled TypeScript ───────────────

const PARSE_OPTIONS = Object.freeze({
  sourceType: "module" as const,
  // Both trees are `.ts`; neither uses JSX, and enabling it would change how
  // `<T>` is read. The plugin set is deliberately NOT derived from a filename,
  // because callers hold source text rather than paths.
  plugins: ["typescript" as const],
  attachComment: false,
});

/**
 * One parseable region of a source: its AST, the text the AST's offsets are
 * relative to, and where that text starts in the original source.
 */
type ParsedRegion = Readonly<{ ast: AstNode; text: string; offset: number }>;

function tryParseScript(text: string): Readonly<{ ast?: AstNode; message?: string }> {
  try {
    return { ast: parse(text, PARSE_OPTIONS) as unknown as AstNode };
  } catch (error) {
    return { message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The `<script>` element bodies of a component file, with their offsets.
 *
 * A Svelte component is not TypeScript and no TypeScript parser will read one,
 * so its script blocks are lifted out first. WHICH FORM A SOURCE IS is decided
 * by the PARSER rather than by looking for a tag: five first-party `.ts` files
 * contain the text `<script` inside a string literal, and a tag-first rule
 * would misread every one of them.
 */
function scriptElementBodies(source: string): readonly Readonly<{ text: string; offset: number }>[] {
  const out: { text: string; offset: number }[] = [];
  // One case-insensitive expression for both tags: the closing tag must be
  // complete and case-folded too, so `<SCRIPT>` / `</SCRIPT >` are read as the
  // HTML they are. A non-greedy body keeps the first close per block. The
  // lgtm marker is deliberate: the parser differential suite drives this shape.
  const scriptBlock = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi; // lgtm[js/bad-tag-filter]
  for (const m of source.matchAll(scriptBlock)) {
    const openEnd = m[0].indexOf(">") + 1;
    out.push({ text: m[1]!, offset: m.index + openEnd });
  }
  return out;
}

/**
 * THE PARTS OF THIS SOURCE THAT ARE TYPESCRIPT, with where each one starts.
 *
 * ONE OWNER for "which regions of a file can be parsed at all", because every
 * guard that wants to reason about a component's code needs the same answer and
 * a second copy of the `<script>` convention would drift from this one. For a
 * plain `.ts` source the answer is "all of it, at offset 0"; for a component it
 * is one region per script block.
 */
export function parseableRegionsOf(
  source: string,
  what = "source",
): readonly Readonly<{ text: string; offset: number }>[] {
  return parsedRegionsOf(source, what).map((region) => ({ text: region.text, offset: region.offset }));
}

/**
 * The last few parses, by source content.
 *
 * A CALLER ASKS ONE SOURCE SEVERAL QUESTIONS. The estate scan reads every guard
 * file's regular expressions and then its `slice` windows, and a guard commonly
 * asks for a body and then for the calls to something in the same file — so the
 * SAME text was being parsed two and three times in a row. Measured: adding the
 * second universe to the estate scan took that file from 2.5 s to 4.9 s, all of
 * it a re-parse of text already in memory.
 *
 * SMALL ON PURPOSE, unlike the named-function cache next to it. That one holds
 * NAMES AND SPANS, which are tiny; this holds ASTs, which are not — a
 * thousand-entry cache of them across the guard estate would be hundreds of
 * megabytes. Eight is enough for "the questions one caller asks about one file
 * before moving on", which is the whole access pattern, and it is bounded so
 * nothing accumulates.
 */
const PARSED_REGIONS = new Map<string, readonly ParsedRegion[]>();
const PARSED_REGION_CACHE_ENTRIES = 8;

function parsedRegionsOf(source: string, what: string): readonly ParsedRegion[] {
  const cached = PARSED_REGIONS.get(source);
  if (cached !== undefined) return cached;
  const parsed = parseRegions(source, what);
  if (PARSED_REGIONS.size >= PARSED_REGION_CACHE_ENTRIES) {
    const oldest = PARSED_REGIONS.keys().next();
    if (!oldest.done) PARSED_REGIONS.delete(oldest.value);
  }
  PARSED_REGIONS.set(source, parsed);
  return parsed;
}

function parseRegions(source: string, what: string): readonly ParsedRegion[] {
  const whole = tryParseScript(source);
  if (whole.ast !== undefined) return [{ ast: whole.ast, text: source, offset: 0 }];
  const out: ParsedRegion[] = [];
  for (const block of scriptElementBodies(source)) {
    const parsed = tryParseScript(block.text);
    if (parsed.ast !== undefined) out.push({ ast: parsed.ast, text: block.text, offset: block.offset });
  }
  if (out.length === 0) {
    throw new InputError(
      `${what}: this source is neither parseable as TypeScript nor a component carrying a parseable <script> block, so nothing structural can be read from it — ${whole.message ?? "no parser diagnostic"}. `
      + "A helper that guessed here would return a region that only looks structural, which is worse than the window it replaces.",
      "source_structure_unparsable",
    );
  }
  return out;
}

// ── Named functions, as the parser sees them ──────────────────────────────

type FunctionSpan = Readonly<{ nameAt: number; bodyStart: number; bodyEnd: number; facts: ScopeFacts }>;

function nodeStart(node: AstNode): number {
  return typeof node.start === "number" ? node.start : -1;
}

function nodeEnd(node: AstNode): number {
  return typeof node.end === "number" ? node.end : -1;
}

/**
 * The declared name a node carries, when it is a plain (non-computed) one.
 *
 * A CLASS PRIVATE MEMBER IS NAMED, and it is named `#thing`. Babel gives
 * `#consumeChunk` a `PrivateName` key rather than an `Identifier`, so a version
 * of this function that accepted only the two public forms returned `undefined`
 * for every one of them — which made `case "ClassPrivateMethod"` and
 * `case "ClassPrivateProperty"` below unable to record anything at all. Twenty-
 * seven private methods in these trees were refused by a module that carried
 * two branches claiming to handle them: a branch that cannot fire is worse than
 * an absent one, because it reads as coverage.
 *
 * The `#` is KEPT in the name, because that is how the member is written and how
 * a guard will ask for it; `#consumeChunk` and a sibling `consumeChunk` are two
 * different members and must not collapse to one entry.
 */
function declaredName(key: AstNode | undefined, computed: unknown): string | undefined {
  if (key === undefined || computed === true) return undefined;
  if (key.type === "Identifier" && typeof key.name === "string") return key.name;
  if (key.type === "StringLiteral" && typeof key.value === "string") return key.value;
  if (key.type === "PrivateName") {
    const id = astNode(key.id);
    return id !== undefined && typeof id.name === "string" ? `#${id.name}` : undefined;
  }
  return undefined;
}

const FUNCTION_NODE_TYPES = new Set(["FunctionExpression", "ArrowFunctionExpression", "FunctionDeclaration"]);

/**
 * An expression-bodied arrow's body, INCLUDING the parentheses that wrap it.
 *
 * `() => ({ ok: true })` has a body of `({ ok: true })`, not `{ ok: true }`:
 * the parentheses are how the expression is written and dropping them would
 * hand back a region whose first character is not where the body starts. Babel
 * records the wrapping rather than giving it a node, which is the one place its
 * spans and TypeScript's differ — and the differential acceptance test compares
 * against TypeScript, so this is measured rather than assumed.
 */
function withEnclosingParentheses(body: AstNode, text: string): Readonly<{ from: number; to: number }> {
  const extra = body.extra as Readonly<{ parenthesized?: boolean; parenStart?: number }> | undefined;
  if (extra?.parenthesized !== true || typeof extra.parenStart !== "number") {
    return { from: nodeStart(body), to: nodeEnd(body) };
  }
  let unclosed = 0;
  for (const ch of text.slice(extra.parenStart, nodeStart(body))) if (ch === "(") unclosed += 1;
  let to = nodeEnd(body);
  while (unclosed > 0 && to < text.length) {
    if (text[to] === ")") unclosed -= 1;
    to += 1;
  }
  return { from: extra.parenStart, to };
}

/** The function-valued node a declaration binds, when it binds one. */
function functionValue(value: unknown): AstNode | undefined {
  const node = astNode(value);
  if (node === undefined || !FUNCTION_NODE_TYPES.has(node.type)) return undefined;
  return astNode(node.body) === undefined ? undefined : node;
}

/**
 * THE BODY OF A FUNCTION NODE, AS A SUBJECT — the ONLY way this module turns a
 * function into something facts can be read from.
 *
 * There is exactly one of these because there was exactly one bug: two call
 * sites each computed the body span themselves and then, separately, asked for
 * facts. One of them asked about the wrong node and nothing could tell, because
 * the two answers travelled as two arguments. Here they travel as one value.
 *
 * `undefined` when the node has no body — an overload signature, a `declare
 * function`, an interface member — because a construct with no body is not a
 * function this module can answer about, which is how "the return type came
 * back as the body" stops existing rather than being detected.
 */
function bodySubjectOf(fn: AstNode, text: string): ScopeSubject | undefined {
  const body = astNode(fn.body);
  if (body === undefined) return undefined;
  const span = body.type === "BlockStatement"
    ? { from: nodeStart(body) + 1, to: nodeEnd(body) - 1 }
    : withEnclosingParentheses(body, text);
  return { node: body, text, from: span.from, to: span.to } as ScopeSubject;
}

/**
 * A PARSED EXPRESSION AS A SUBJECT — for an attribute's `{…}` value, whose
 * scope is the whole of what was parsed rather than the body of something.
 */
function expressionSubjectOf(ast: AstNode, text: string): ScopeSubject {
  return { node: ast, text, from: 0, to: text.length } as ScopeSubject;
}

/**
 * Every call made anywhere inside THE SUBJECT, as the callee's source text with
 * whitespace removed (`db . getProject(…)` and `db.getProject(…)` are one
 * call). Taken from the CALL GRAPH rather than from a regular expression over
 * the body text, so a name that appears only in a comment or a string is not a
 * call — which is the shape a guard in this workspace has already been fooled
 * by.
 *
 * ── THE RUNTIME CHOKE POINT, AND WHY IT IS HERE RATHER THAN IN A TEST ──────
 *
 * The subject type makes "facts of a wider node" unwritable; this makes it
 * unsurvivable. Every fact is recorded with the span it came from, and the
 * union of those spans must lie INSIDE the subject's own. That single
 * comparison is the general form of three separate defects — a fact drawn from
 * a default parameter, a fact drawn from a decorator or a computed key, and a
 * whole fact set copied from a NEIGHBOURING function — because all three put a
 * fact outside the region the scope hands back as its `body`. It costs two
 * number comparisons per contributing node and it turns a silent wrong answer
 * into a refusal, which is the only trade this workspace has ever wanted here.
 */
function scopeFactsIn(subject: ScopeSubject): ScopeFacts {
  const regionText = subject.text;
  const calls = new Set<string>();
  const callArguments = new Map<string, (readonly string[])[]>();
  const bindings = new Map<string, Set<string>>();
  const returns = new Set<string>();
  const strings: string[] = [];
  // The span every recorded fact was read from, widened as facts are found.
  let readFrom = Number.POSITIVE_INFINITY;
  let readTo = Number.NEGATIVE_INFINITY;
  const readAt = (child: AstNode): void => {
    const start = nodeStart(child);
    const end = nodeEnd(child);
    if (start < 0 || end < start) return;
    if (start < readFrom) readFrom = start;
    if (end > readTo) readTo = end;
  };

  /** A node's own source text with whitespace removed, or `undefined`. */
  const textOf = (child: AstNode | undefined): string | undefined => {
    if (child === undefined) return undefined;
    const start = nodeStart(child);
    const end = nodeEnd(child);
    if (start < 0 || end < start) return undefined;
    return regionText.slice(start, end).replace(/\s+/g, "");
  };
  const bind = (name: string | undefined, to: string | undefined): void => {
    if (name === undefined || to === undefined) return;
    const already = bindings.get(name);
    if (already === undefined) bindings.set(name, new Set([to]));
    else already.add(to);
  };

  walkAst(subject.node, (child) => {
    switch (child.type) {
      case "CallExpression":
      case "OptionalCallExpression":
      case "NewExpression": {
        const callee = textOf(astNode(child.callee));
        if (callee === undefined) return;
        readAt(child);
        calls.add(callee);
        const args = astNodeArray(child.arguments)
          .map((argument) => textOf(argument))
          .filter((text): text is string => text !== undefined);
        const forCallee = callArguments.get(callee);
        if (forCallee === undefined) callArguments.set(callee, [Object.freeze(args)]);
        else forCallee.push(Object.freeze(args));
        return;
      }
      // ONE CASE FOR BOTH DIRECTIONS. Babel spells `{ cursor: _cursor }` and
      // `const { cursor: _cursor } = x` with the same node, so "this body
      // relates `cursor` to `_cursor`" is one question whether the code is
      // building an object or taking one apart — which is what the caller
      // means either way.
      case "ObjectProperty": {
        if (child.computed === true) return;
        readAt(child);
        bind(declaredName(astNode(child.key), false), textOf(astNode(child.value)));
        return;
      }
      case "AssignmentExpression": {
        readAt(child);
        bind(textOf(astNode(child.left)), textOf(astNode(child.right)));
        return;
      }
      case "VariableDeclarator": {
        const id = astNode(child.id);
        if (id?.type !== "Identifier") return;
        readAt(child);
        bind(declaredName(id, false), textOf(astNode(child.init)));
        return;
      }
      case "ReturnStatement": {
        // `return;` returns nothing, and "nothing" is a real answer a guard may
        // want to make a claim about, so it is spelled rather than dropped.
        readAt(child);
        returns.add(textOf(astNode(child.argument)) ?? "");
        return;
      }
      case "StringLiteral": {
        if (typeof child.value !== "string") return;
        readAt(child);
        strings.push(child.value);
        return;
      }
      case "TemplateElement": {
        const cooked = (child.value as Readonly<{ cooked?: unknown }> | undefined)?.cooked;
        if (typeof cooked !== "string") return;
        readAt(child);
        strings.push(cooked);
        return;
      }
      default:
        return;
    }
  });

  // EVERY FACT CAME FROM INSIDE THE SCOPE, OR THERE ARE NO FACTS TO HAND BACK.
  // Not a defensive assertion: this is the door the three default-parameter
  // defects would each have had to walk through, and it is the only place that
  // can see a fact whose bytes are not in the text the caller will be shown.
  if (readTo > readFrom && (readFrom < subject.from || readTo > subject.to)) {
    throw new InputError(
      `a scope's facts were read from ${String(readFrom)}..${String(readTo)}, outside the ${String(subject.from)}..${String(subject.to)} it hands back as its body. `
      + "A door would then answer `true` about text the scope does not contain — which is the proximity-window defect with a parser's face on it.",
      "source_structure_facts_outside_scope",
    );
  }

  return Object.freeze({
    calls,
    callArguments,
    bindings,
    returns,
    strings: Object.freeze(strings),
  });
}

/**
 * THE NAMED FUNCTIONS OF ONE PARSED REGION.
 *
 * Recognised because the PARSER says so, not because a regular expression
 * matched a declaration form: a function declaration, a `const`/`let`/`var`
 * bound to a function or arrow, an object property or class field bound to one,
 * and an object or class method. A construct with no body — an overload
 * signature, `declare function`, an interface member `f: (x) => T;` — is simply
 * not a function with a body and does not enter the table, which is how the
 * "return type returned as the body" class stops existing rather than being
 * detected.
 */
function collectFunctions(region: ParsedRegion, into: Map<string, FunctionSpan[]>): void {
  const record = (name: string | undefined, nameAt: number, fn: AstNode | undefined): void => {
    if (name === undefined || fn === undefined) return;
    // ONE SUBJECT, so the span below and the facts below CANNOT be about two
    // different nodes. They were two arguments once, and the second one named
    // the whole function — see {@link ScopeSubject}.
    const subject = bodySubjectOf(fn, region.text);
    if (subject === undefined) return;
    const bodyStart = subject.from + region.offset;
    const bodyEnd = subject.to + region.offset;
    if (bodyStart < region.offset || bodyEnd < bodyStart) return;
    const at = nameAt + region.offset;
    // EVERY DECLARATION, NEVER A WINNER. The previous version kept the first in
    // source order and justified it on DETERMINISM — but determinism was never
    // the question. A file holding two `runGitConfined`s, one reaching
    // `gitText` and one spawning raw, answered a guard about the first and said
    // nothing about the second: the module's own headline defect, selected by
    // declaration order instead of by byte distance. 136 of 6,580 names in
    // these trees are declared more than once. Which one a caller meant is
    // UNKNOWN INPUT, and unknown input is refused at the door (see
    // {@link functionBody}) rather than guessed here.
    const already = into.get(name);
    const entry = { nameAt: at, bodyStart, bodyEnd, facts: scopeFactsIn(subject) };
    if (already === undefined) into.set(name, [entry]);
    else already.push(entry);
  };

  walkAst(region.ast, (node) => {
    switch (node.type) {
      case "FunctionDeclaration": {
        const id = astNode(node.id);
        if (id !== undefined && astNode(node.body) !== undefined) record(declaredName(id, false), nodeStart(id), node);
        return;
      }
      case "VariableDeclarator": {
        const id = astNode(node.id);
        if (id !== undefined && id.type === "Identifier") record(declaredName(id, false), nodeStart(id), functionValue(node.init));
        return;
      }
      case "ObjectProperty":
      case "ClassProperty":
      case "ClassPrivateProperty":
      case "PropertyDefinition": {
        const key = astNode(node.key);
        if (key !== undefined) record(declaredName(key, node.computed), nodeStart(key), functionValue(node.value));
        return;
      }
      case "ObjectMethod":
      case "ClassMethod":
      case "ClassPrivateMethod": {
        const key = astNode(node.key);
        if (key !== undefined && astNode(node.body) !== undefined) record(declaredName(key, node.computed), nodeStart(key), node);
        return;
      }
      default:
        return;
    }
  });
}

/**
 * The named-function table for one source, cached by content.
 *
 * MEASURED BEFORE CACHING, as the rule requires: parsing all 853 first-party
 * `.ts` files of both production trees (9.6 MB) costs 438 ms — half a
 * millisecond per file — so the sixteen guard call sites would not notice the
 * absence of a cache at all. The cache exists for the differential acceptance
 * test, which asks 6,512 names across those same files and would otherwise
 * re-parse each file once per name it holds.
 */
const FUNCTION_TABLES = new Map<string, ReadonlyMap<string, readonly FunctionSpan[]>>();

/**
 * How many parsed sources to remember. Not a tuning knob for anybody: it bounds
 * the memory of a helper whose whole population is "the source files one guard
 * reads", and the eviction is oldest-first so a walk of a tree keeps working at
 * full speed with the window sliding behind it.
 */
const FUNCTION_TABLE_CACHE_ENTRIES = 2048;

function namedFunctions(source: string, what: string): ReadonlyMap<string, readonly FunctionSpan[]> {
  const cached = FUNCTION_TABLES.get(source);
  if (cached !== undefined) return cached;
  const table = new Map<string, FunctionSpan[]>();
  for (const region of parsedRegionsOf(source, what)) collectFunctions(region, table);
  for (const spans of table.values()) spans.sort((a, b) => a.nameAt - b.nameAt);
  const frozen: ReadonlyMap<string, readonly FunctionSpan[]> = table;
  if (FUNCTION_TABLES.size >= FUNCTION_TABLE_CACHE_ENTRIES) {
    const oldest = FUNCTION_TABLES.keys().next();
    if (!oldest.done) FUNCTION_TABLES.delete(oldest.value);
  }
  FUNCTION_TABLES.set(source, frozen);
  return frozen;
}

/**
 * THE BODY OF A NAMED FUNCTION, as a parser reads it rather than as a byte
 * count guesses it.
 *
 * THROWS when the name names no function with a body. That is the whole point:
 * a scope helper that returned an empty string for a missing function would
 * turn "this function no longer exists" into "this function contains nothing
 * wrong", which is the vacuous-scan defect wearing the new API's clothes.
 *
 * AND THROWS WHEN THE NAME NAMES TWO. An ambiguous subject is UNKNOWN INPUT,
 * and unknown input is an error rather than a silent default. The previous
 * version answered with whichever declaration came first in source order, so a
 * guard asserting "`runGitConfined` reaches `gitText`" returned TRUE while a
 * second `runGitConfined` in the same file spawned raw — the neighbour defect
 * this module exists to remove, arriving through the tie-break instead of
 * through a byte count. Callers that genuinely mean "all of them" ask
 * {@link functionBodies}, which says so.
 */
export function functionBody(source: string, name: string, what = `function ${name}`): SourceScope {
  const found = namedFunctions(source, what).get(name);
  if (found === undefined || found.length === 0) {
    throw new InputError(
      `${what}: no declaration of \`${name}\` with a body was found in this source, so there is no body to look inside. `
      + "A guard whose subject has vanished must fail rather than report that nothing is wrong with it.",
      "source_structure_subject_absent",
    );
  }
  if (found.length > 1) {
    throw new InputError(
      `${what}: \`${name}\` is declared ${found.length} times with a body in this source, at offsets ${found.map((span) => span.nameAt).join(", ")}, `
      + "so which one the claim is about is unknown. Answering with one of them would make the claim true of that declaration and silent about the others, "
      + "which is how a neighbour satisfies a guard. Use functionBodies() to make a claim about every declaration, or narrow the source to the one you mean.",
      "source_structure_subject_ambiguous",
    );
  }
  return scopeOf(source, name, found[0]!);
}

/**
 * EVERY DECLARATION OF `name` WITH A BODY, in source order.
 *
 * The door for a caller who means "all of them" — and the reason
 * {@link functionBody} can afford to refuse an ambiguous name outright rather
 * than picking one. A claim made through this door is made about each
 * declaration, so a second one cannot be silently exempt.
 *
 * THROWS when there are none, for the same reason {@link functionBody} does: an
 * empty list would turn "this function has vanished" into "nothing is wrong
 * with it".
 */
export function functionBodies(source: string, name: string, what = `function ${name}`): readonly SourceScope[] {
  const found = namedFunctions(source, what).get(name);
  if (found === undefined || found.length === 0) {
    throw new InputError(
      `${what}: no declaration of \`${name}\` with a body was found in this source, so there is no body to look inside. `
      + "A guard whose subject has vanished must fail rather than report that nothing is wrong with it.",
      "source_structure_subject_absent",
    );
  }
  return Object.freeze(found.map((span) => scopeOf(source, name, span)));
}

/**
 * A scope for a name the caller DISCOVERED rather than named.
 *
 * Separate from {@link functionBody} rather than a flag on it, because the
 * THROWING form is the one guards must use — a helper that returns "nothing
 * found" for a subject that has vanished is the vacuous-scan defect.
 */
function scopeOf(source: string, name: string, span: FunctionSpan): SourceScope {
  return issueScope("function", name, source.slice(span.bodyStart, span.bodyEnd), span.bodyStart, span.facts);
}

/**
 * THE DECLARATIONS OF THE RULE THIS SELECTOR BELONGS TO.
 *
 * A DIFFERENT QUESTION FROM `cssBlock`, and that is why it is here rather than
 * delegating to it. `cssBlock` answers "what follows `selector {`", which is
 * only the same thing when the selector stands alone. Real stylesheets group:
 *
 *     .level-ghost .options,
 *     .level-tick .options {  height: 0;  }
 *
 * `cssBlock` returns "" for `.level-ghost .options` there, and "" is also what
 * it returns for a selector that does not exist — so a guard built on it cannot
 * tell a GROUPED rule from a MISSING one. This walks the comma-separated
 * prelude, so a selector that is one of several still names its rule, and
 * REFUSES when the selector is genuinely absent.
 *
 * STILL READ BY HAND, and the reason is specific rather than an omission: this
 * workspace's only stylesheet parser is the tree-sitter CSS grammar, which is a
 * WebAssembly module and therefore asynchronous, and every one of this module's
 * doors is synchronous and called from inside assertions. The construct is also
 * far simpler than a TypeScript signature — a prelude, a brace, a balanced
 * block, with strings and `/* … *​/` comments the only complications — and it is
 * driven over every live stylesheet by the acceptance test. Recorded as a task
 * rather than dismissed.
 */
export function cssRule(source: string, selector: string, what = `CSS rule ${selector}`): SourceScope {
  const wanted = selector.trim().replace(/\s+/g, " ");
  let cursor = 0;
  while (cursor < source.length) {
    const brace = source.indexOf("{", cursor);
    if (brace < 0) break;
    // The prelude is everything since the previous rule's `}`, its `{`, or a
    // `;` (an @import or a declaration inside a nested block).
    const start = Math.max(
      source.lastIndexOf("}", brace),
      source.lastIndexOf("{", brace - 1),
      source.lastIndexOf(";", brace),
    ) + 1;
    const prelude = source.slice(start, brace);
    const selectors = prelude.split(",").map((s) => s.trim().replace(/\s+/g, " ")).filter((s) => s.length > 0);
    if (selectors.includes(wanted)) {
      const end = balanceTo(source, brace, "{", "}", what);
      return issueScope("css-rule", selector, source.slice(brace + 1, end - 1), brace + 1);
    }
    cursor = brace + 1;
  }
  throw new InputError(
    `${what}: no rule in this stylesheet has \`${selector}\` among its selectors, so it has no declarations. `
    + "An absent rule and an empty rule are the same string, and they must not be the same verdict.",
    "source_structure_subject_absent",
  );
}

/**
 * THE BODY OF A MARKUP ELEMENT identified by one of its attributes — the
 * structural anchor for the template scans, which were reaching for a window
 * because an element has no braces.
 *
 * `attribute` is matched literally (e.g. `data-chord-target="open-scope"`), and
 * the scope runs from the start of that element's tag to the end of the tag, so
 * an assertion about "this element's handler" cannot be satisfied by the NEXT
 * element's. Read by hand for the same recorded reason as {@link cssRule}.
 */
export function elementWithAttribute(source: string, attribute: string, what = `element with ${attribute}`): SourceScope {
  const at = source.indexOf(attribute);
  if (at < 0) {
    throw new InputError(
      `${what}: no element carries \`${attribute}\` in this template, so there is no element to look inside.`,
      "source_structure_subject_absent",
    );
  }
  const open = source.lastIndexOf("<", at);
  if (open < 0) throw new InputError(`${what}: \`${attribute}\` is not inside a tag`, "source_structure_subject_absent");
  // The end of the OPENING tag: the first `>` not inside a quoted attribute or
  // a `{…}` expression, both of which routinely contain `>`.
  let i = open;
  let depth = 0;
  while (i < source.length) {
    const skipped = skipLiteral(source, i);
    if (skipped !== i) { i = skipped; continue; }
    const c = source[i]!;
    if (c === "{") depth += 1;
    else if (c === "}") depth -= 1;
    else if (c === ">" && depth === 0) {
      return issueScope("element", attribute, source.slice(open, i + 1), open);
    }
    i += 1;
  }
  throw new InputError(`${what}: the tag carrying \`${attribute}\` never closes`, "source_structure_unbalanced");
}

/**
 * DOES THIS RULE DECLARE `property` AS `value`?
 *
 * Two names and a value, no pattern. The declarations of a rule are a list of
 * `property: value` pairs separated by `;`, so "does this rule set height to 0"
 * is a lookup rather than a match — and `height: 0` cannot be satisfied by a
 * `max-height: 0` or by a `height` in a nested block, both of which a substring
 * pattern accepts.
 *
 * `value` is compared with whitespace collapsed, so `var(--sp-1)` reads the
 * same however it is spaced, and a trailing `;` is not part of it.
 *
 * NESTED BLOCKS ARE NOT THIS RULE'S DECLARATIONS. A media query or a nested
 * selector inside the body carries its own, and folding them in would answer a
 * question about the rule with a fact about something inside it.
 */
export function cssDeclares(scope: SourceScope, property: string, value: string): boolean {
  if (!isSourceScope(scope) || scope.kind !== "css-rule") {
    throw new InputError(
      "cssDeclares expects a rule from cssRule(), not raw source or another kind of scope. "
      + "A declaration list belongs to one rule, and asking a whole stylesheet is how a neighbour's declaration answers for this one.",
      "source_structure_not_a_scope",
    );
  }
  const wantedProperty = property.trim();
  const wantedValue = value.trim().replace(/\s+/g, " ");
  let depth = 0;
  let start = 0;
  const declarations: string[] = [];
  for (let i = 0; i < scope.body.length; i += 1) {
    const skipped = skipLiteral(scope.body, i);
    if (skipped !== i) { i = skipped - 1; continue; }
    const c = scope.body[i]!;
    if (c === "{" || c === "(") depth += 1;
    else if (c === "}" || c === ")") depth -= 1;
    else if (c === ";" && depth === 0) { declarations.push(scope.body.slice(start, i)); start = i + 1; }
  }
  declarations.push(scope.body.slice(start));
  for (const declaration of declarations) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    if (declaration.slice(0, colon).trim() !== wantedProperty) continue;
    if (declaration.slice(colon + 1).trim().replace(/\s+/g, " ") === wantedValue) return true;
  }
  return false;
}

/**
 * THE VALUE OF ONE OF THIS ELEMENT'S ATTRIBUTES, as its own scope.
 *
 * The door that lets a claim about an element's handler stop being a claim
 * about the bytes near its name. `elementWithAttribute` bounds the TAG; this
 * bounds ONE ATTRIBUTE inside it, so `attributeOf(el, "onclick")` cannot be
 * satisfied by a different attribute of the same element, let alone a different
 * element.
 *
 * A `{…}` value is CODE, and it is parsed: the returned scope carries the same
 * facts a function body does, so `bodyCallsWith(attributeOf(el, "onclick"),
 * "onopenbeat", ["beat.id"])` asks the call graph of that one handler. A quoted
 * value is text and its scope is the text between the quotes, compared with
 * `.body` — an exact string, which is what an attribute value is.
 *
 * THROWS when the element does not carry the attribute, for the reason every
 * door here throws: an absent attribute and an empty one must not be the same
 * verdict.
 */
export function attributeOf(scope: SourceScope, name: string, what = `attribute ${name}`): SourceScope {
  if (!isSourceScope(scope) || scope.kind !== "element") {
    throw new InputError(
      "attributeOf expects an element from elementWithAttribute(), not raw source or another kind of scope. "
      + "Searching a whole template for an attribute is how a neighbouring element's handler answers for this one.",
      "source_structure_not_a_scope",
    );
  }
  const found = attributesOf(scope.body, what).find((attribute) => attribute.name === name);
  if (found === undefined) {
    throw new InputError(
      `${what}: the element \`${scope.name}\` does not carry \`${name}\`, so there is no value to look at. `
      + "An absent attribute and an empty one must not be the same verdict.",
      "source_structure_subject_absent",
    );
  }
  const text = scope.body.slice(found.from, found.to);
  if (found.value === "none") {
    // A bare attribute (`disabled`) has no value. Its scope is empty, and it
    // exists — which is a different fact from the attribute being absent.
    return issueScope("attribute", name, "", scope.offset + found.from, EMPTY_FACTS);
  }
  return found.value === "code"
    ? issueScope("attribute", name, text, scope.offset + found.from, expressionFacts(text, what))
    : issueScope("attribute", name, text, scope.offset + found.from);
}

/** One attribute of one tag, found by POSITION. */
type TagAttribute = Readonly<{
  name: string;
  /** How the value is written — `code` is a `{…}` expression, `none` is a bare attribute. */
  value: "code" | "text" | "none";
  /** The value's span within the tag text, excluding quotes or braces. */
  from: number;
  to: number;
}>;

/**
 * THE ATTRIBUTES OF ONE OPENING TAG, IN ORDER, FOUND BY WALKING ATTRIBUTE
 * POSITIONS — never by searching the tag's text for a name.
 *
 * ── WHY POSITION, AND NOT A PATTERN ───────────────────────────────────────
 *
 * This used to build `(?:^|[\s])<name>(?=[\s=/>])` and run it over the RAW TAG
 * TEXT, which includes the contents of every other attribute's quoted value.
 * Both directions were wrong and both were silent:
 *
 *     <div data-x="1" title="the class thing" class="real" />
 *       attributeOf(el, "class").body  ->  ""     the match landed in `title`
 *
 *     <EmptyState title="the kind of thing shown" />
 *       attributeOf(el, "kind")        ->  a scope with body ""
 *
 * The second one is the vacuous-scan defect that this door's own documentation
 * forbids two paragraphs above — an absent attribute reported as an empty one —
 * printed and then committed. A guard written `attributeOf(el, "kind").body ===
 * "error"` read FALSE (a false accusation) and one written `!== "debug"` read
 * TRUE (a false pass).
 *
 * Walking positions removes both at once, and it removes the last construction
 * of a `RegExp` from any exported function here — which is what lets the
 * acceptance instrument assert "no exported door builds a pattern" as a
 * property with nothing exempted.
 *
 * A SHORTHAND `{name}` IS AN ATTRIBUTE. `<input {value} />` binds `value`, and
 * the previous rule required whitespace before the name, so the shorthand form
 * was reported ABSENT — the same false absence, arriving from the other side.
 * `{...rest}` spreads and names nothing, so it contributes nothing.
 */
function attributesOf(tag: string, what: string): readonly TagAttribute[] {
  const out: TagAttribute[] = [];
  const isSpace = (at: number): boolean => {
    const c = tag[at];
    return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";
  };
  // Past `<` and the tag name — everything after it is an attribute position.
  let i = 1;
  while (i < tag.length && !isSpace(i) && tag[i] !== ">" && tag[i] !== "/") i += 1;
  while (i < tag.length) {
    while (i < tag.length && isSpace(i)) i += 1;
    if (i >= tag.length || tag[i] === ">") break;
    if (tag[i] === "/" && tag[i + 1] === ">") break;
    if (tag[i] === "{") {
      const end = balanceTo(tag, i, "{", "}", what);
      const inside = tag.slice(i + 1, end - 1).trim();
      // A shorthand names itself; a spread names nothing.
      if (/^[A-Za-z_$][\w$]*$/.test(inside)) out.push({ name: inside, value: "code", from: i + 1, to: end - 1 });
      i = end;
      continue;
    }
    const nameFrom = i;
    while (i < tag.length && !isSpace(i) && tag[i] !== "=" && tag[i] !== ">" && tag[i] !== "/") i += 1;
    const name = tag.slice(nameFrom, i);
    if (name.length === 0) { i += 1; continue; }
    let after = i;
    while (after < tag.length && isSpace(after)) after += 1;
    if (tag[after] !== "=") {
      out.push({ name, value: "none", from: nameFrom, to: nameFrom });
      continue;
    }
    after += 1;
    while (after < tag.length && isSpace(after)) after += 1;
    const opener = tag[after];
    if (opener === "{") {
      const end = balanceTo(tag, after, "{", "}", what);
      out.push({ name, value: "code", from: after + 1, to: end - 1 });
      i = end;
      continue;
    }
    if (opener === '"' || opener === "'") {
      const end = skipLiteral(tag, after);
      out.push({ name, value: "text", from: after + 1, to: end - 1 });
      i = end;
      continue;
    }
    // An unquoted value runs to the next whitespace or to the end of the tag.
    let end = after;
    while (end < tag.length && !isSpace(end) && tag[end] !== ">" && tag[end] !== "/") end += 1;
    out.push({ name, value: "text", from: after, to: end });
    i = end;
  }
  return Object.freeze(out);
}

/** The facts of a bare attribute: it exists, and it says nothing. */
const EMPTY_FACTS: ScopeFacts = Object.freeze({
  calls: new Set<string>(),
  callArguments: new Map<string, readonly (readonly string[])[]>(),
  bindings: new Map<string, ReadonlySet<string>>(),
  returns: new Set<string>(),
  strings: Object.freeze([]),
});

/**
 * The facts of an attribute's `{…}` expression.
 *
 * Parsed as an EXPRESSION rather than as a module, because `(e) => …` is not a
 * statement and a module parse of it fails. A value that does not parse is
 * refused rather than treated as text: a handler this module could not read is
 * a handler no claim here can honestly be made about.
 */
function expressionFacts(text: string, what: string): ScopeFacts {
  const wrapped = tryParseScript(`(${text}\n)`);
  if (wrapped.ast === undefined) {
    throw new InputError(
      // The value is NOT excerpted into the message. A truncation length here
      // would be one more hardcoded number, and the parser's own diagnostic
      // already carries the position — while `what` names the attribute, which
      // is what the reader needs to find it.
      `${what}: this attribute's value is not parseable as an expression, so nothing structural can be read from it — ${wrapped.message ?? "no parser diagnostic"}.`,
      "source_structure_unparsable",
    );
  }
  // The offsets inside the wrapper are one character ahead of the value's own,
  // and every fact is name text rather than a span, so the shift never escapes.
  const wrapper = `(${text}\n)`;
  return scopeFactsIn(expressionSubjectOf(wrapped.ast, wrapper));
}

/**
 * DOES THIS BODY CALL `callee`? Two identifiers, no pattern, nowhere to put a
 * window — the rung-2 form, and the shape every door below is built to.
 *
 * `callee` may be a dotted path (`db.getProject`). The answer comes from the
 * CALLS THE PARSER FOUND inside the body, so a call written across a line break
 * is still a call, a longer name ending in `callee` is not one (`spawnRawGit`
 * does not satisfy `rawGit`), and — the part a regular expression could not do
 * — a name that appears only inside a comment or a string literal is not one
 * either.
 */
export function bodyCalls(scope: SourceScope, callee: string): boolean {
  return factsOf(scope, "bodyCalls").calls.has(callee.replace(/\s+/g, ""));
}

/**
 * DOES THIS BODY CALL `callee` AND GIVE IT THESE ARGUMENTS?
 *
 * The commonest claim that used to need a pattern: not merely "the verifier
 * calls the detector" but "the verifier calls the detector ON THE REDACTED
 * TEXT". Both halves are now names — `bodyCallsWith(scope,
 * "detectSecretSpans", ["redactedText"])` — so the claim has nowhere to put a
 * gap, and the argument is compared as the PARSER delimited it rather than as
 * a regular expression guessed where it ended. `f(a, g(b, c))` has two
 * arguments here and would have had three to `[^)]*`.
 *
 * `argumentNames` is matched as a PREFIX of one call's argument list, because
 * that is what the claims mean: "…is called on the redacted text" is about the
 * first argument and stays true when an option is appended later. It is a
 * prefix of ONE call, never assembled across several — a body that calls
 * `f(a)` and `f(b)` does not satisfy `["a", "b"]`.
 *
 * Whitespace is removed from both sides before comparing, so a call broken
 * across lines reads the same as one written on a single line.
 */
export function bodyCallsWith(scope: SourceScope, callee: string, argumentNames: readonly string[]): boolean {
  const wanted = argumentNames.map((name) => name.replace(/\s+/g, ""));
  const callsToCallee = factsOf(scope, "bodyCallsWith").callArguments.get(callee.replace(/\s+/g, ""));
  if (callsToCallee === undefined) return false;
  return callsToCallee.some((args) =>
    args.length >= wanted.length && wanted.every((name, at) => args[at] === name));
}

/**
 * DOES THIS BODY RELATE `name` TO `toName`?
 *
 * One door for the four ways source relates two names, because a caller asking
 * "does the refresh send the reset cursor" does not care which of them the code
 * happens to use: an object property (`{ cursor: _cursor }`), a destructuring
 * rename (`const { cursor: _cursor } = current`), an assignment (`entries =
 * source`) and a declaration (`const entries = source`) are one question.
 * Splitting them into four doors would be four chances to ask the wrong one and
 * get a clean verdict.
 */
export function bodyBinds(scope: SourceScope, name: string, toName: string): boolean {
  const bound = factsOf(scope, "bodyBinds").bindings.get(name.replace(/\s+/g, ""));
  return bound !== undefined && bound.has(toName.replace(/\s+/g, ""));
}

/**
 * DOES THIS BODY `return` EXACTLY THIS?
 *
 * `value` is the returned expression as written, compared with whitespace
 * removed — `bodyReturns(scope, "[]")` is "returns an empty array", and it is
 * satisfied by nothing else. A bare `return;` is spelled `""`.
 *
 * EXACT, NEVER A SUBSTRING: `return []` and `return [fallback]` are different
 * answers, and a containment test would call the second one the first.
 */
export function bodyReturns(scope: SourceScope, value: string): boolean {
  return factsOf(scope, "bodyReturns").returns.has(value.replace(/\s+/g, ""));
}

/**
 * DOES THIS BODY SAY THIS, IN WORDS IT EMITS?
 *
 * The one claim that is genuinely about TEXT rather than about structure: a
 * handler that cannot resolve an event must SAY so, and the words are the
 * point. `phrase` is a plain string and is found by containment, so there is no
 * wildcard to write and no distance to bound — which is the whole reason this
 * can exist beside doors that take names.
 *
 * The population is the STRING AND TEMPLATE LITERALS the parser found in this
 * body, never a comment: a comment claiming the handler reports something is
 * not the handler reporting it, and a scan over body text could not tell the
 * two apart.
 */
export function bodySays(scope: SourceScope, phrase: string): boolean {
  return factsOf(scope, "bodySays").strings.some((text) => text.includes(phrase));
}

/**
 * EVERY ARGUMENT LIST PASSED TO `callee` IN THIS SOURCE, balanced.
 *
 * The structural answer to "what is this call actually given", which guards
 * were reaching for with a window because an options object has no fixed
 * length. A window gets it wrong in both directions and both are silent: too
 * short and a long options object drops OUT of the population, too long and an
 * unrelated neighbour drops IN. The calls come from the parser, so a call named
 * in a comment contributes nothing and a call spanning ten lines contributes
 * once.
 */
export function callArgumentsOf(source: string, callee: string, what = `calls to ${callee}`): readonly string[] {
  const wanted = callee.replace(/\s+/g, "");
  const out: string[] = [];
  for (const region of parsedRegionsOf(source, what)) {
    const text = source.slice(region.offset);
    walkAst(region.ast, (node) => {
      if (node.type !== "CallExpression" && node.type !== "OptionalCallExpression" && node.type !== "NewExpression") return;
      const calleeNode = astNode(node.callee);
      if (calleeNode === undefined) return;
      if (text.slice(nodeStart(calleeNode), nodeEnd(calleeNode)).replace(/\s+/g, "") !== wanted) return;
      const typeArguments = astNode(node.typeParameters) ?? astNode(node.typeArguments);
      const afterCallee = typeArguments === undefined ? nodeEnd(calleeNode) : nodeEnd(typeArguments);
      const open = text.indexOf("(", afterCallee);
      if (open < 0) return;
      out.push(text.slice(open + 1, nodeEnd(node) - 1));
    });
  }
  return Object.freeze(out);
}

/**
 * EVERY OBJECT LITERAL IN `source` THAT DECLARES `property` AS `value`, each
 * one as its OWN properties, by name.
 *
 * The structural answer to "the object that carries this discriminant", which
 * guards were reaching for with a window because an object literal has no fixed
 * length. It used to take a `RegExp` and hand back the literal's raw TEXT,
 * which meant the caller then wrote a second pattern to read a field out of it
 * — a pattern door feeding a pattern, with the "is this property mine or my
 * nested object's" question answered by blanking the nested spans and matching
 * again.
 *
 * Asking the parser for the OWN properties answers both at once: the map holds
 * exactly this literal's properties, so a container carrying nothing but a
 * nested match is simply not in the population, and the caller reads a field by
 * name instead of by pattern.
 *
 * NESTED OBJECTS ARE FLATTENED ONTO DOTTED PATHS, because the shape guards
 * actually ask about is nested: a tool is declared as
  * `{ type: "function", function: { name: "edit", … } }`, so the
 * discriminant and the name the caller wants live at different depths. The path
 * says which — `objectLiteralsWith(src, "type", "function")` selects, and
 * `literal.get("function.name")` reads. A version that offered only the OWN
 * properties would have made this call site unanswerable, and one that matched
 * the literal's whole TEXT — which is what the `RegExp` door did — could not
 * tell a property of this object from a property of one nested inside it, and
 * needed the nested spans blanked and re-matched to guess.
 *
 * Values are the source text with whitespace removed, except that a string
 * literal is UNQUOTED — `type: "function"` is `"function"` to a reader and
 * `function` to this map, because the quotes are how the value is written and
 * not part of it. Computed and spread properties have no name and are absent.
 */
/**
 * The object literal behind a single-argument wrapper call, or the node itself.
 *
 * `deepFreeze({ name: "git_status", … })` DECLARES that object in this source —
 * the literal is written right there — and a reader of the file would say so.
 * Fifteen of the twenty-six tool declarations in this workspace are wrapped this
 * way, at every level of their nesting, so a flattener that stopped at the call
 * would have silently shrunk a guard's universe from twenty-six to eleven while
 * still reporting a clean run. That is the universe defect this module exists
 * to argue against, so the wrapper is followed.
 *
 * THE EDGE, STATED: this does not verify the callee is a pass-through. A
 * `transform({ a: 1 })` is read as declaring `a: 1`, which is true of the SOURCE
 * — the question these doors answer — and may not be true of the runtime value.
 * Only a single-argument call is followed, so nothing is merged from siblings.
 */
function unwrapped(node: AstNode | undefined): AstNode | undefined {
  if (node?.type !== "CallExpression") return node;
  const args = astNodeArray(node.arguments);
  return args.length === 1 && args[0]!.type === "ObjectExpression" ? args[0] : node;
}

export function objectLiteralsWith(
  source: string,
  property: string,
  value: string,
  what = "object literals",
): readonly ReadonlyMap<string, string>[] {
  const wantedValue = value.replace(/\s+/g, "");
  const out: ReadonlyMap<string, string>[] = [];
  for (const region of parsedRegionsOf(source, what)) {
    const fieldsOf = (node: AstNode, prefix: string, into: Map<string, string>): void => {
      for (const declared of astNodeArray(node.properties)) {
        if (declared.type !== "ObjectProperty" && declared.type !== "ObjectMethod") continue;
        const name = declaredName(astNode(declared.key), declared.computed);
        if (name === undefined) continue;
        const path = prefix + name;
        const valueNode = unwrapped(astNode(declared.value));
        if (valueNode === undefined) { into.set(path, ""); continue; }
        if (valueNode.type === "ObjectExpression") { fieldsOf(valueNode, `${path}.`, into); continue; }
        into.set(
          path,
          valueNode.type === "StringLiteral" && typeof valueNode.value === "string"
            ? valueNode.value
            : region.text.slice(nodeStart(valueNode), nodeEnd(valueNode)).replace(/\s+/g, ""),
        );
      }
    };
    walkAst(region.ast, (node) => {
      if (node.type !== "ObjectExpression") return;
      const fields = new Map<string, string>();
      fieldsOf(node, "", fields);
      if (fields.get(property) === wantedValue) out.push(fields);
    });
  }
  return Object.freeze(out);
}

/**
 * ONE EXPORTED BINDING, and — the part that matters — whether this source can
 * SEE what it is.
 *
 * `kind` is the whole point. An export whose nature cannot be read here is not
 * absent and must not be reported as absent: `export { f } from "./other.ts"`
 * exports a real callable whose signature lives in another file, and a
 * mechanism that silently omitted it certified a module as having no pattern
 * door while three working ones were reachable through it. So the unreadable
 * case is a VALUE with a name, not a gap in the map.
 */
export type ExportedBinding = Readonly<{
  /**
   * `function` — this source declares it and its parameters are below.
   * `value` — exported here, but not function-valued (a constant, a class, a
   * type-only re-export).
   * `elsewhere` — exported FROM another module, so nothing about it can be read
   * from this source. A caller that certifies a module's surface must treat
   * this as unknown rather than as empty.
   */
  kind: "function" | "value" | "elsewhere";
  /** The parameter list as written, empty for a zero-parameter function. */
  parameters: string;
  /** How the export is spelled, for a failure message that can be acted on. */
  form: "declaration" | "specifier" | "default" | "star";
  /**
   * THE NAME THIS SOURCE DECLARES IT UNDER, which is not always the name it is
   * exported under: `export { plantedLocal as plantedDoor }` is one binding
   * with two names, and a caller that asks {@link functionBody} for the
   * EXPORTED name gets "no such declaration" — a refusal that reads exactly
   * like "there is no such door". `undefined` when the declaration is in
   * another module.
   */
  declaredAs: string | undefined;
}>;

/**
 * EVERY EXPORTED BINDING OF THIS SOURCE, BY NAME AND BY FORM.
 *
 * ── WHY THIS IS NOT "the parameters of every exported function" ────────────
 *
 * It was, and that was a universe defect wearing an acceptance instrument's
 * clothes. The previous version walked `ExportNamedDeclaration` /
 * `ExportDefaultDeclaration` and kept only those whose `declaration` was a
 * `FunctionDeclaration`. Fourteen pattern-doors were planted into a copy of the
 * module it certifies and it saw five. Three of the misses were planted into
 * the REAL file and left it green while each one demonstrably answered a
 * proximity window `true` where the call graph says `false`:
 *
 *     export const f = (s, pattern: RegExp) => …     an arrow binding
 *     function f(…: RegExp) {} ; export { f }        a specifier
 *     export { bodyMatches } from "./legacy.ts"      a re-export
 *
 * None of the three is exotic; the first is how most of this workspace writes
 * a callback. "A door added tomorrow is covered because nobody had to remember"
 * was FALSE, and it was false in the ordinary direction.
 *
 * So the question this answers is now the WHOLE export surface, and the two
 * routes it cannot follow are NAMED rather than dropped — which is what lets a
 * caller assert a property over every export instead of over the subset one
 * declaration form happens to produce.
 *
 * `export * from "…"` cannot name anything, so it appears once under the name
 * `*`. A module carrying one has an export surface this source does not know,
 * and a certifier must say so rather than count what it can see.
 */
export function exportedBindings(source: string, what = "exported bindings"): ReadonlyMap<string, ExportedBinding> {
  const out = new Map<string, ExportedBinding>();
  for (const region of parsedRegionsOf(source, what)) {
    /** The parameter text of a function-valued node, or `undefined`. */
    const parametersOf = (node: AstNode | undefined): string | undefined => {
      if (node === undefined || !FUNCTION_NODE_TYPES.has(node.type)) return undefined;
      const parameters = astNodeArray(node.params);
      if (parameters.length === 0) return "";
      const from = nodeStart(parameters[0]!);
      const to = nodeEnd(parameters[parameters.length - 1]!);
      return from < 0 || to < from ? "" : region.text.slice(from, to);
    };

    // WHAT THIS SOURCE DECLARES, so a specifier can be resolved to it. A
    // specifier export is the commonest way a signature hides from a walk that
    // only reads declarations, and resolving it costs one pass.
    const local = new Map<string, AstNode | undefined>();
    walkAst(region.ast, (node) => {
      if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") {
        const id = astNode(node.id);
        if (id?.type === "Identifier" && typeof id.name === "string") local.set(id.name, node);
        return;
      }
      if (node.type !== "VariableDeclarator") return;
      const id = astNode(node.id);
      if (id?.type === "Identifier" && typeof id.name === "string") local.set(id.name, astNode(node.init));
    });

    const record = (
      name: string,
      node: AstNode | undefined,
      form: ExportedBinding["form"],
      declaredAs: string | undefined,
      kind?: ExportedBinding["kind"],
    ): void => {
      const parameters = parametersOf(node);
      out.set(name, Object.freeze({
        kind: kind ?? (parameters === undefined ? "value" : "function"),
        parameters: parameters ?? "",
        form,
        declaredAs,
      }));
    };

    walkAst(region.ast, (node) => {
      if (node.type === "ExportAllDeclaration") {
        record("*", undefined, "star", undefined, "elsewhere");
        return;
      }
      if (node.type === "ExportDefaultDeclaration") {
        const declared = astNode(node.declaration);
        const viaName = declared?.type === "Identifier" ? String(declared.name) : undefined;
        const id = declared === undefined ? undefined : astNode(declared.id);
        record(
          "default",
          viaName === undefined ? declared : local.get(viaName),
          "default",
          viaName ?? (id?.type === "Identifier" && typeof id.name === "string" ? id.name : undefined),
        );
        return;
      }
      if (node.type !== "ExportNamedDeclaration") return;
      const declared = astNode(node.declaration);
      if (declared !== undefined) {
        // `export function f() {}`, `export const f = …`, `export class C {}`.
        if (declared.type === "VariableDeclaration") {
          for (const declarator of astNodeArray(declared.declarations)) {
            const id = astNode(declarator.id);
            if (id?.type === "Identifier" && typeof id.name === "string") record(id.name, astNode(declarator.init), "declaration", id.name);
          }
          return;
        }
        const id = astNode(declared.id);
        if (id?.type === "Identifier" && typeof id.name === "string") record(id.name, declared, "declaration", id.name);
        return;
      }
      // `export { f }`, `export { f as g }`, `export { f } from "./other.ts"`.
      const fromAnotherModule = astNode(node.source) !== undefined;
      for (const specifier of astNodeArray(node.specifiers)) {
        const exported = astNode(specifier.exported) ?? astNode(specifier.local);
        const name = declaredName(exported, false);
        if (name === undefined) continue;
        if (fromAnotherModule) { record(name, undefined, "specifier", undefined, "elsewhere"); continue; }
        const localName = declaredName(astNode(specifier.local), false);
        record(name, localName === undefined ? undefined : local.get(localName), "specifier", localName);
      }
    });
  }
  return out;
}

/**
 * THE PARAMETER LIST OF EVERY EXPORTED FUNCTION, by name — a projection of
 * {@link exportedBindings} rather than a second walk of the source.
 *
 * The structural answer to "which entry points take this argument", which
 * guards were asking with `/export\s+function\s+(\w+)\s*\(([^)]*)\)/` — a
 * pattern with two independent ways to be wrong, both measured. It cannot see
 * `export async function`, which hid three of forty-four gate-taking bridge
 * entry points and therefore hid the one route that called one of them without
 * a gate; and `[^)]*` stops at the first `)`, so any parameter that is itself a
 * function type (`onDone: () => void`) truncates the list it is supposed to
 * read. A parser has neither failure mode.
 *
 * The text is returned verbatim rather than split, because the caller's question
 * is about the TYPES as written and a structured form would have to re-encode
 * them.
 *
 * A CALLER CERTIFYING A MODULE'S WHOLE SURFACE MUST USE {@link exportedBindings}
 * INSTEAD: this map can only contain what this source can read, so an export
 * that comes from another module is simply not in it — and "not in the map"
 * reads as "no such door" to anybody who forgets.
 */
export function exportedFunctionParameters(source: string, what = "exported functions"): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const [name, binding] of exportedBindings(source, what)) {
    if (binding.kind === "function") out.set(name, binding.parameters);
  }
  return out;
}

/**
 * EVERY PATTERN IN `source` THAT EXPRESSES A PROXIMITY WINDOW, with where it is
 * written.
 *
 * THE ESTATE SCAN'S UNIVERSE, SUPPLIED BY THE OWNER. Rung 5 exists because
 * nothing above it can reach a guard that never imports this module, and it was
 * being done by matching the raw text of each line against a second copy of the
 * spelling list — two owners for one judgement, and a universe that cannot tell
 * a regular expression from English prose. Measured on the two guard trees, a
 * text scan flags forty comment lines about `console.*` and `cfg.*` and misses
 * every pattern written across two lines.
 *
 * Reading the PARSED source instead removes both errors at once: a
 * `RegExpLiteral` is unambiguously a pattern, `new RegExp("…")` is caught by the
 * same walk, and a pattern inside a comment does not exist. Measured cost over
 * 924 guard files (12 MB): 829 ms.
 *
 * A pattern assembled from concatenated fragments is not visible here — stated
 * because a universe with an unstated edge is the failure this whole estate is
 * about. The rung-4 door catches those, because by the time one runs it is a
 * `RegExp`.
 */
export function regexLiteralsIn(
  source: string,
  what = "patterns",
): readonly Readonly<{ pattern: string; offset: number }>[] {
  const out: { pattern: string; offset: number }[] = [];
  for (const region of parsedRegionsOf(source, what)) {
    walkAst(region.ast, (node) => {
      if (node.type === "RegExpLiteral" && typeof node.pattern === "string") {
        out.push({ pattern: node.pattern, offset: nodeStart(node) + region.offset });
        return;
      }
      if (node.type !== "NewExpression" && node.type !== "CallExpression") return;
      const callee = astNode(node.callee);
      if (callee === undefined || callee.type !== "Identifier" || callee.name !== "RegExp") return;
      const first = astNodeArray(node.arguments)[0];
      if (first?.type === "StringLiteral" && typeof first.value === "string") {
        out.push({ pattern: first.value, offset: nodeStart(node) + region.offset });
      }
    });
  }
  return Object.freeze(out);
}

/** A window built out of ARITHMETIC rather than out of a pattern. */
export type SliceWindow = Readonly<{
  /** The call as written, for the failure message. */
  text: string;
  /** How many units wide — the number that IS the guess. */
  extent: number;
  /** Where the call begins in the source. */
  offset: number;
}>;

/**
 * EVERY `x.slice(start, start + N)` IN `source` — the proximity window a scan
 * whose universe is REGULAR EXPRESSIONS cannot see at all.
 *
 * ── WHY THE REGEX UNIVERSE WAS THE WRONG UNIVERSE ─────────────────────────
 *
 * The estate scan reads {@link regexLiteralsIn} and asks whether a pattern
 * bounds a distance between two anchors. That is the right question about the
 * wrong population: exactly the same claim can be written without a pattern.
 *
 *     const fnStart = src.indexOf("export async function fetchJson");
 *     const fnBody  = src.slice(fnStart, fnStart + 2000);
 *     expect(fnBody).toContain("credentials");
 *
 * "…appears within two thousand bytes of the declaration" is the module's
 * headline defect in its original form, and deleting the pattern door does not
 * reach it, because there is no pattern. Measured across the two guard trees:
 * 452 two-argument `.slice()` calls, of which 27 take a literal extent of ten
 * or more — two of them in files a previous round converted off the pattern
 * door and left the arithmetic behind.
 *
 * The SHAPE is what identifies it, and it is not a heuristic: the second
 * argument is the first argument PLUS A NUMBER. A `slice(a, b)` between two
 * found positions bounds nothing by distance and is not reported; a
 * `slice(0, 60)` truncating for a message has no start expression to repeat
 * and is not reported either.
 *
 * NO THRESHOLD IS APPLIED HERE. The extent is reported and the caller decides,
 * for the same reason {@link patternGapIn} classifies and {@link windowGapIn}
 * judges: the lexing is a fact and the cut-off is a policy, and a policy baked
 * into the reader cannot be re-derived by the scan that has to publish it.
 */
export function sliceWindowsIn(source: string, what = "slice windows"): readonly SliceWindow[] {
  const out: SliceWindow[] = [];
  for (const region of parsedRegionsOf(source, what)) {
    walkAst(region.ast, (node) => {
      if (node.type !== "CallExpression" && node.type !== "OptionalCallExpression") return;
      const callee = astNode(node.callee);
      if (callee === undefined || (callee.type !== "MemberExpression" && callee.type !== "OptionalMemberExpression")) return;
      if (declaredName(astNode(callee.property), callee.computed) !== "slice") return;
      const args = astNodeArray(node.arguments);
      if (args.length !== 2) return;
      const extentNode = args[1]!;
      if (extentNode.type !== "BinaryExpression" || extentNode.operator !== "+") return;
      const left = astNode(extentNode.left);
      const right = astNode(extentNode.right);
      if (left === undefined || right?.type !== "NumericLiteral" || typeof right.value !== "number") return;
      const startText = region.text.slice(nodeStart(args[0]!), nodeEnd(args[0]!)).replace(/\s+/g, "");
      if (region.text.slice(nodeStart(left), nodeEnd(left)).replace(/\s+/g, "") !== startText) return;
      out.push({
        text: region.text.slice(nodeStart(node), nodeEnd(node)).replace(/\s+/g, " "),
        extent: right.value,
        offset: nodeStart(node) + region.offset,
      });
    });
  }
  return Object.freeze(out);
}

/**
 * Every pattern in `source` that expresses a proximity window, with its
 * classification — built on {@link regexLiteralsIn}, so the scan can report how
 * many patterns it READ as well as how many it faulted. A scan that reports
 * only its findings cannot tell "nothing is wrong" from "nothing was read".
 */
export function windowedPatternsIn(
  source: string,
  what = "patterns",
): readonly Readonly<{ pattern: string; gap: PatternGap; offset: number }>[] {
  const out: { pattern: string; gap: PatternGap; offset: number }[] = [];
  for (const { pattern, offset } of regexLiteralsIn(source, what)) {
    const gap = firstGapIn(pattern);
    if (gap === undefined || !gap.anchored) continue;
    if (!gap.bounded && !gap.greedy) continue;
    out.push({ pattern, gap, offset });
  }
  return Object.freeze(out);
}

/**
 * THE BODIES OF THE FUNCTIONS HANDED TO `callee` — the handler registered for
 * an event, scoped to itself.
 *
 * `process.on("uncaughtException", (err) => { … })` registers an ANONYMOUS
 * function, so {@link functionBody} has no name to ask for, and guards reached
 * for a window instead: `/uncaughtException[\s\S]*process\.exit\(1\)/` over the
 * whole of a server entry point. That is satisfied by any `process.exit(1)`
 * anywhere after the registration — including one in a DIFFERENT handler — and
 * three assertions written that way sat in a file the estate scan called clean.
 *
 * `argumentNames` selects WHICH registration, as a prefix of the call's
 * arguments exactly as {@link bodyCallsWith} does, so the event name is a name
 * rather than an anchor. Every function-valued argument of a matching call gets
 * a scope, in source order.
 *
 * THROWS when no call matches, for the reason every door here throws: a handler
 * that has been renamed away must fail the guard that asserts about it, not
 * report that nothing is wrong with it.
 */
export function functionArgumentsOf(
  source: string,
  callee: string,
  argumentNames: readonly string[] = [],
  what = `functions passed to ${callee}`,
): readonly SourceScope[] {
  const wantedCallee = callee.replace(/\s+/g, "");
  const wanted = argumentNames.map((name) => name.replace(/\s+/g, ""));
  const out: SourceScope[] = [];
  let matchedCalls = 0;
  for (const region of parsedRegionsOf(source, what)) {
    walkAst(region.ast, (node) => {
      if (node.type !== "CallExpression" && node.type !== "OptionalCallExpression" && node.type !== "NewExpression") return;
      const calleeNode = astNode(node.callee);
      if (calleeNode === undefined) return;
      if (region.text.slice(nodeStart(calleeNode), nodeEnd(calleeNode)).replace(/\s+/g, "") !== wantedCallee) return;
      const args = astNodeArray(node.arguments);
      const asText = args.map((a) => region.text.slice(nodeStart(a), nodeEnd(a)).replace(/\s+/g, ""));
      if (args.length < wanted.length || !wanted.every((name, at) => asText[at] === name)) return;
      matchedCalls += 1;
      for (let argument of args) {
        // A handler wrapped in a measurement/decorator call —
        // `addEventListener(name, measured((e) => {…}))` — is still the
        // handler that was registered; the wrapper only forwards the
        // event. Reading THROUGH a one-function-argument call keeps this
        // door's subject ("functions passed to callee") true when the
        // registration wraps its listener, instead of reporting the
        // handler absent because a wrapper stands in front of it.
        for (;;) {
          if (FUNCTION_NODE_TYPES.has(argument.type)) break;
          if (argument.type !== "CallExpression" && argument.type !== "OptionalCallExpression") break;
          const wrappedArgs = astNodeArray(argument.arguments)
            .filter((a) => FUNCTION_NODE_TYPES.has(a.type));
          if (wrappedArgs.length !== 1) break;
          argument = wrappedArgs[0]!;
        }
        if (!FUNCTION_NODE_TYPES.has(argument.type)) continue;
        // The SAME subject the named-function table is built from — a handler
        // registered inline has a signature too, and this door read its facts
        // from the whole arrow for exactly as long as the other one did.
        const subject = bodySubjectOf(argument, region.text);
        if (subject === undefined) continue;
        out.push(issueScope(
          "function",
          `${callee}(${argumentNames.join(", ")})`,
          source.slice(subject.from + region.offset, subject.to + region.offset),
          subject.from + region.offset,
          scopeFactsIn(subject),
        ));
      }
    });
  }
  if (matchedCalls === 0) {
    throw new InputError(
      `${what}: no call to \`${callee}\`${wanted.length === 0 ? "" : ` beginning with ${argumentNames.join(", ")}`} was found in this source, so there is no handler to look inside. `
      + "A guard whose subject has vanished must fail rather than report that nothing is wrong with it.",
      "source_structure_subject_absent",
    );
  }
  return Object.freeze(out);
}

/**
 * WHAT A NAMED BINDING IS INITIALISED TO, as its own scope.
 *
 * The structural answer to "this constant is built from these things", which
 * guards were asking with a lazy run from the NAME to something that looks like
 * the end of the value:
 *
 *     /const bestExtractor[\s\S]*?\.name\s*\?\?\s*"none"/
 *     /EMPTY_COMPOSITION_ROOTS[\s\S]*?=\s*deepFreeze\(\{([\s\S]*?)\}\s*\)/
 *
 * Both say "the value of this name is the text between it and the next thing
 * that looks like a terminator", and both are satisfied by a NEIGHBOUR: driven,
 * a sibling `bestTrigger?.name ?? "none"` makes the first one stop early and
 * the guard's verdict FLIPS, and a sibling `OTHER_ROOTS = deepFreeze({a:1})`
 * makes the second one capture the neighbour's fields as if they were this
 * constant's.
 *
 * The parser knows where a declarator's initializer starts and ends, so the
 * region is exact and the facts are the initializer's own — a caller can ask
 * `bodyCalls(scope, "deepFreeze")` about the value as readily as it can read
 * `.body`.
 *
 * REFUSES an absent name and an AMBIGUOUS one, for the same reasons
 * {@link functionBody} does: a vanished constant must fail its guard rather
 * than report that nothing is wrong with it, and answering about one of two
 * declarations is how a neighbour satisfies a claim.
 */
export function bindingValueOf(source: string, name: string, what = `binding ${name}`): SourceScope {
  const found: ScopeSubject[] = [];
  const offsets: number[] = [];
  for (const region of parsedRegionsOf(source, what)) {
    walkAst(region.ast, (node) => {
      if (node.type !== "VariableDeclarator" && node.type !== "ClassProperty" && node.type !== "PropertyDefinition") return;
      const id = astNode(node.id) ?? astNode(node.key);
      if (declaredName(id, node.computed) !== name) return;
      const value = astNode(node.init) ?? astNode(node.value);
      if (value === undefined) return;
      found.push({ node: value, text: region.text, from: nodeStart(value), to: nodeEnd(value) } as ScopeSubject);
      offsets.push(region.offset);
    });
  }
  if (found.length === 0) {
    throw new InputError(
      `${what}: no declaration of \`${name}\` with a value was found in this source, so there is nothing to look inside. `
      + "A guard whose subject has vanished must fail rather than report that nothing is wrong with it.",
      "source_structure_subject_absent",
    );
  }
  if (found.length > 1) {
    throw new InputError(
      `${what}: \`${name}\` is initialised ${found.length} times in this source, so which one the claim is about is unknown. `
      + "Answering with one of them would make the claim true of that declaration and silent about the others.",
      "source_structure_subject_ambiguous",
    );
  }
  const subject = found[0]!;
  const at = subject.from + offsets[0]!;
  return issueScope("binding", name, source.slice(at, subject.to + offsets[0]!), at, scopeFactsIn(subject));
}

/**
 * THE INNERMOST FUNCTION BODY CONTAINING `offset` — the door for a guard that
 * found something by scanning and needs to know WHAT IT IS INSIDE.
 *
 * ── WHY A NAMED-FUNCTION DOOR COULD NOT CARRY THIS ────────────────────────
 *
 * {@link functionsCalling} answers "which NAMED functions call this", and the
 * constructs that matter most in a guard estate have no name: a test body is
 * `test("…", async () => { … })`, and an arrow passed to a runner is exactly
 * the region a claim about "this test" is about. A guard that has an offset —
 * from a line scan, from {@link regexLiteralsIn}, from anything — and wants the
 * enclosing construct has been reaching for a LINE WINDOW instead, and a line
 * window is the same guess in a different unit. Measured on the safety guard
 * that owns "a test which attempts a real write must restore it in a
 * `finally`": its sixty-line window was satisfied by a DIFFERENT TEST's
 * restore twenty lines away, so a test that never restored anything passed.
 *
 * INNERMOST, because a nested arrow inside a test body is a different subject
 * from the test body, and answering with the outer one is how a claim about a
 * callback becomes a claim about everything around it.
 *
 * `undefined` when the offset is at top level, which is a real answer rather
 * than a missing one — and a caller must treat it as "not inside anything",
 * never as "inside something that is fine".
 */
export function enclosingFunctionOf(source: string, offset: number, what = "enclosing function"): SourceScope | undefined {
  let best: ScopeSubject | undefined;
  let bestOffset = 0;
  for (const region of parsedRegionsOf(source, what)) {
    walkAst(region.ast, (node) => {
      if (!FUNCTION_NODE_TYPES.has(node.type) && node.type !== "ObjectMethod" && node.type !== "ClassMethod" && node.type !== "ClassPrivateMethod") return;
      const subject = bodySubjectOf(node, region.text);
      if (subject === undefined) return;
      const from = subject.from + region.offset;
      const to = subject.to + region.offset;
      if (offset < from || offset > to) return;
      // Narrower wins, so a callback inside a test body answers for itself.
      if (best !== undefined && to - from > best.to - best.from) return;
      best = subject;
      bestOffset = region.offset;
    });
  }
  if (best === undefined) return undefined;
  return issueScope(
    "function",
    what,
    source.slice(best.from + bestOffset, best.to + bestOffset),
    best.from + bestOffset,
    scopeFactsIn(best),
  );
}

/**
 * THE SCOPES OF EVERY NAMED FUNCTION IN `source` THAT CALLS `callee`.
 *
 * Lets a guard say "every function that lists a directory orders its listing"
 * instead of "an ordering call appears somewhere after a listing call", which
 * is what a window says and is a different, weaker claim.
 */
export function functionsCalling(source: string, callee: string, what = `functions calling ${callee}`): readonly SourceScope[] {
  const wanted = callee.replace(/\s+/g, "");
  const out: SourceScope[] = [];
  for (const [name, spans] of namedFunctions(source, what)) {
    // EVERY DECLARATION OF THE NAME, not the first. This door's whole purpose
    // is "make this claim about all of them", so a name declared twice
    // contributes both — the caller never has to know it was ambiguous.
    for (const span of spans) if (span.facts.calls.has(wanted)) out.push(scopeOf(source, name, span));
  }
  return Object.freeze(out);
}
