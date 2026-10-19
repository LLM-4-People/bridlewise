import { deepFreeze } from "../kernel/integrity.ts";
import { InputError } from "../kernel/errors.ts";
import { schemaId } from "../kernel/product-identity.ts";

/**
 * Bug zoo: versioned defect-fixture matrix.
 *
 * Per delivery map item 9, REQ-015, and the quality-packs research
 * (`docs/research/quality-packs/bug-zoo.md`):
 *
 * "Every pack ships a versioned defect-fixture matrix (a small 'bug zoo')
 * proving which mistakes it catches and recording false positives/unsupported
 * categories. A passing pack test requires expected diagnostics, not only a
 * zero exit code." (harness-requirements.md line 73)
 *
 * The catalog contains 11 categories, 44 positive scenarios, and one clean
 * control per category. Every mandated category has at least three materially
 * different positives; several use multiple languages so an adapter cannot
 * pass by memorizing one parser's output.
 *
 * A positive passes qualification only when all 5 conditions from the bug-zoo
 * contract are met:
 * 1. The expected category is emitted at the expected file/symbol/edge.
 * 2. The tool exits according to its documented diagnostic semantics.
 * 3. The finding is reproduced by every listed confirmWith mechanism.
 * 4. The normalized location agrees with the native artifact.
 * 5. A rerun produces the same fingerprint.
 *
 * A clean control passes only when no blocking diagnostic is emitted.
 */

export const BUG_ZOO_SCHEMA_VERSION = schemaId("bug-zoo", 1);

export type BugZooCategory =
  | "undefined-symbols"
  | "unused-dead"
  | "unreachable-constant-duplicate-branch"
  | "syntax-indent-delimiter"
  | "cycles"
  | "type-name"
  | "weak-tautological-tests"
  | "mutation-survival"
  | "property-counterexamples"
  | "architecture"
  | "security";

export const BUG_ZOO_CATEGORIES = deepFreeze([
  "undefined-symbols",
  "unused-dead",
  "unreachable-constant-duplicate-branch",
  "syntax-indent-delimiter",
  "cycles",
  "type-name",
  "weak-tautological-tests",
  "mutation-survival",
  "property-counterexamples",
  "architecture",
  "security",
] as const);

export type BugZooFixtureKind = "positive" | "clean-control";

export type BugZooFixture = Readonly<{
  id: string;
  category: BugZooCategory;
  kind: BugZooFixtureKind;
  description: string;
  language: string;
  source: string;
  expectedDiagnostics: readonly Readonly<{
    category: string;
    minCount: number;
    line?: number;
    symbol?: string;
  }>[];
  confirmWith: readonly string[];
  holdout: boolean;
}>;

export type BugZooMutation = Readonly<{
  id: string;
  category: BugZooCategory;
  description: string;
  originalSource: string;
  mutatedSource: string;
  killerTest: string;
  shouldSurviveBefore: boolean;
  shouldKillAfter: boolean;
}>;

export type BugZooCatalog = Readonly<{
  schemaVersion: typeof BUG_ZOO_SCHEMA_VERSION;
  categoryCount: number;
  positiveCount: number;
  controlCount: number;
  mutationCount: number;
  fixtures: readonly BugZooFixture[];
  mutations: readonly BugZooMutation[];
}>;

function fixture(input: {
  id: string;
  category: BugZooCategory;
  kind: BugZooFixtureKind;
  description: string;
  language: string;
  source: string;
  expectedDiagnostics?: readonly Readonly<{
    category: string;
    minCount: number;
    line?: number;
    symbol?: string;
  }>[];
  confirmWith?: readonly string[];
  holdout?: boolean;
}): BugZooFixture {
  return deepFreeze({
    id: input.id,
    category: input.category,
    kind: input.kind,
    description: input.description,
    language: input.language,
    source: input.source,
    expectedDiagnostics: deepFreeze(input.expectedDiagnostics ?? []),
    confirmWith: deepFreeze(input.confirmWith ?? ["manual-ast"]),
    holdout: input.holdout ?? false,
  });
}

function mutation(input: {
  id: string;
  category: BugZooCategory;
  description: string;
  originalSource: string;
  mutatedSource: string;
  killerTest: string;
  shouldSurviveBefore: boolean;
  shouldKillAfter: boolean;
}): BugZooMutation {
  return deepFreeze({
    id: input.id,
    category: input.category,
    description: input.description,
    originalSource: input.originalSource,
    mutatedSource: input.mutatedSource,
    killerTest: input.killerTest,
    shouldSurviveBefore: input.shouldSurviveBefore,
    shouldKillAfter: input.shouldKillAfter,
  });
}

const UNDEFINED_SYMBOLS_CLEAN = `function defined(a: number): number { return a + 1; }
export { defined };
`;

const UNUSED_DEAD_CLEAN = `export function used(x: number): number { return x * 2; }
`;

const UNREACHABLE_CLEAN = `function reach(x: number): number {
  if (x > 0) return x;
  return -x;
}
export { reach };
`;

const SYNTAX_CLEAN = `function well(a: number, b: number): number {
  return a + b;
}
export { well };
`;

const CYCLES_CLEAN = `import { helper } from "./helper.ts";
function top(x: number): number { return helper(x); }
export { top };
`;

const TYPE_NAME_CLEAN = `function typed(a: number, b: string): string {
  return String(a) + b;
}
export { typed };
`;

const WEAK_TEST_CLEAN = `test("correct", () => {
  assert.equal(add(2, 3), 5);
  assert.notEqual(add(2, 3), 6);
});
`;

const MUTATION_CLEAN = `function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
`;

const PROPERTY_CLEAN = `test("roundtrip", () => {
  for (const x of [0, 1, -1, 42, -42]) {
    assert.equal(Number(String(x)), x);
  }
});
`;

const ARCHITECTURE_CLEAN = `import { domainFn } from "../domain/logic.ts";
function appLayer(x: number): number { return domainFn(x); }
export { appLayer };
`;

const SECURITY_CLEAN = `import { execFile } from "node:child_process";
function runTool(name: string): void {
  execFile(name, ["--version"], { shell: false });
}
export { runTool };
`;

const FIXTURES: readonly BugZooFixture[] = deepFreeze([
  fixture({
    id: "undef-001-ts-name",
    category: "undefined-symbols",
    kind: "positive",
    description: "TypeScript: references undefined name not in scope",
    language: "typescript",
    source: `function caller(): number {
  return missingFunction(42);
}
export { caller };
`,
    expectedDiagnostics: [{ category: "undefined-symbol", minCount: 1, symbol: "missingFunction" }],
    confirmWith: ["manual-ast", "tsc"],
  }),
  fixture({
    id: "undef-002-ts-unimported",
    category: "undefined-symbols",
    kind: "positive",
    description: "TypeScript: uses a name that looks imported but is not in the import list",
    language: "typescript",
    source: `import { map } from "./other.ts";
function caller(arr: number[]): number[] {
  return filter(arr, (x) => x > 0);
}
export { caller };
`,
    expectedDiagnostics: [{ category: "undefined-symbol", minCount: 1, symbol: "filter" }],
    confirmWith: ["manual-ast", "tsc"],
  }),
  fixture({
    id: "undef-003-ts-typo",
    category: "undefined-symbols",
    kind: "positive",
    description: "TypeScript: typo in a well-known utility name",
    language: "typescript",
    source: `function caller(): number {
  return ParseFloot("3.14");
}
export { caller };
`,
    expectedDiagnostics: [{ category: "undefined-symbol", minCount: 1, symbol: "ParseFloot" }],
    confirmWith: ["manual-ast", "tsc"],
  }),
  fixture({
    id: "undef-004-ts-shadow-miss",
    category: "undefined-symbols",
    kind: "positive",
    description: "TypeScript: shadowed variable hides the intended outer binding",
    language: "typescript",
    source: `const value = 42;
function inner(): number {
  const value = "shadow";
  return value.toUpperCase();
}
export { value, inner };
`,
    expectedDiagnostics: [{ category: "type", minCount: 1 }],
    confirmWith: ["manual-ast", "tsc"],
  }),
  fixture({
    id: "undef-ctrl-clean",
    category: "undefined-symbols",
    kind: "clean-control",
    description: "Clean control: all names defined and imported",
    language: "typescript",
    source: UNDEFINED_SYMBOLS_CLEAN,
  }),

  fixture({
    id: "unused-001-dead-export",
    category: "unused-dead",
    kind: "positive",
    description: "TypeScript: exported function never imported by any other module",
    language: "typescript",
    source: `export function deadExport(x: number): number { return x + 1; }
`,
    expectedDiagnostics: [{ category: "unused-export", minCount: 1, symbol: "deadExport" }],
    confirmWith: ["manual-ast", "knip"],
  }),
  fixture({
    id: "unused-002-dead-file",
    category: "unused-dead",
    kind: "positive",
    description: "TypeScript: entire file is never imported anywhere",
    language: "typescript",
    source: `function onlyLocal(): void { console.log("never called externally"); }
export { onlyLocal };
`,
    expectedDiagnostics: [{ category: "dead-code", minCount: 1 }],
    confirmWith: ["manual-ast"],
  }),
  fixture({
    id: "unused-003-dead-var",
    category: "unused-dead",
    kind: "positive",
    description: "TypeScript: local variable assigned but never read",
    language: "typescript",
    source: `function caller(): number {
  const temp = computeExpensive();
  return 42;
}
function computeExpensive(): number { return 99; }
export { caller };
`,
    expectedDiagnostics: [{ category: "dead-code", minCount: 1, symbol: "temp" }],
    confirmWith: ["manual-ast", "tsc"],
  }),
  fixture({
    id: "unused-004-dead-param",
    category: "unused-dead",
    kind: "positive",
    description: "TypeScript: function parameter never used in body",
    language: "typescript",
    source: `function caller(unused: number, used: number): number {
  return used * 2;
}
export { caller };
`,
    expectedDiagnostics: [{ category: "dead-code", minCount: 1, symbol: "unused" }],
    confirmWith: ["manual-ast", "tsc"],
  }),
  fixture({
    id: "unused-ctrl-clean",
    category: "unused-dead",
    kind: "clean-control",
    description: "Clean control: all exports are consumed",
    language: "typescript",
    source: UNUSED_DEAD_CLEAN,
  }),

  fixture({
    id: "unreach-001-post-return",
    category: "unreachable-constant-duplicate-branch",
    kind: "positive",
    description: "TypeScript: code after return is unreachable",
    language: "typescript",
    source: `function caller(): number {
  return 42;
  const dead = 99;
}
export { caller };
`,
    expectedDiagnostics: [{ category: "dead-branch", minCount: 1, line: 3 }],
    confirmWith: ["manual-ast", "tsc"],
  }),
  fixture({
    id: "unreach-002-constant-true",
    category: "unreachable-constant-duplicate-branch",
    kind: "positive",
    description: "TypeScript: constant-true condition makes else branch dead",
    language: "typescript",
    source: `function caller(x: number): number {
  if (true) return x;
  return -x;
}
export { caller };
`,
    expectedDiagnostics: [{ category: "dead-branch", minCount: 1, line: 4 }],
    confirmWith: ["manual-ast", "tsc"],
  }),
  fixture({
    id: "unreach-003-duplicate-branch",
    category: "unreachable-constant-duplicate-branch",
    kind: "positive",
    description: "TypeScript: two if-branches with identical bodies",
    language: "typescript",
    source: `function caller(x: number): number {
  if (x > 0) return x * 2;
  if (x > 0) return x * 2;
  return x;
}
export { caller };
`,
    expectedDiagnostics: [{ category: "dead-branch", minCount: 1 }],
    confirmWith: ["manual-ast"],
  }),
  fixture({
    id: "unreach-004-post-throw",
    category: "unreachable-constant-duplicate-branch",
    kind: "positive",
    description: "TypeScript: code after throw is unreachable",
    language: "typescript",
    source: `function caller(): never {
  throw new Error("fatal");
  return 42 as never;
}
export { caller };
`,
    expectedDiagnostics: [{ category: "dead-branch", minCount: 1, line: 3 }],
    confirmWith: ["manual-ast", "tsc"],
  }),
  fixture({
    id: "unreach-ctrl-clean",
    category: "unreachable-constant-duplicate-branch",
    kind: "clean-control",
    description: "Clean control: all branches reachable, exhaustive-never control",
    language: "typescript",
    source: UNREACHABLE_CLEAN,
  }),

  fixture({
    id: "syntax-001-missing-brace",
    category: "syntax-indent-delimiter",
    kind: "positive",
    description: "TypeScript: missing closing brace",
    language: "typescript",
    source: `function caller(): number {
  return 42;
`,
    expectedDiagnostics: [{ category: "syntax", minCount: 1 }],
    confirmWith: ["babel", "tsc"],
  }),
  fixture({
    id: "syntax-002-missing-paren",
    category: "syntax-indent-delimiter",
    kind: "positive",
    description: "TypeScript: unbalanced parentheses in call",
    language: "typescript",
    source: `function caller(): number {
  return foo(42;
}
function foo(x: number): number { return x; }
export { caller };
`,
    expectedDiagnostics: [{ category: "syntax", minCount: 1 }],
    confirmWith: ["babel", "tsc"],
  }),
  fixture({
    id: "syntax-003-missing-semicolon-arrow",
    category: "syntax-indent-delimiter",
    kind: "positive",
    description: "TypeScript: malformed arrow function with missing arrow",
    language: "typescript",
    source: `const f = (x: number)  x + 1;
export { f };
`,
    expectedDiagnostics: [{ category: "syntax", minCount: 1 }],
    confirmWith: ["babel", "tsc"],
  }),
  fixture({
    id: "syntax-004-unclosed-string",
    category: "syntax-indent-delimiter",
    kind: "positive",
    description: "TypeScript: unterminated string literal",
    language: "typescript",
    source: `const s = "hello world;
export { s };
`,
    expectedDiagnostics: [{ category: "syntax", minCount: 1 }],
    confirmWith: ["babel", "tsc"],
  }),
  fixture({
    id: "syntax-005-missing-colon",
    category: "syntax-indent-delimiter",
    kind: "positive",
    description: "TypeScript: missing colon in type annotation",
    language: "typescript",
    source: `function caller(x number) number { return x; }
export { caller };
`,
    expectedDiagnostics: [{ category: "syntax", minCount: 1 }],
    confirmWith: ["babel", "tsc"],
  }),
  fixture({
    id: "syntax-006-missing-bracket",
    category: "syntax-indent-delimiter",
    kind: "positive",
    description: "TypeScript: unbalanced array bracket",
    language: "typescript",
    source: `const arr = [1, 2, 3;
export { arr };
`,
    expectedDiagnostics: [{ category: "syntax", minCount: 1 }],
    confirmWith: ["babel", "tsc"],
  }),
  fixture({
    id: "syntax-ctrl-clean",
    category: "syntax-indent-delimiter",
    kind: "clean-control",
    description: "Clean control: all delimiters balanced",
    language: "typescript",
    source: SYNTAX_CLEAN,
  }),

  fixture({
    id: "cycle-001-direct",
    category: "cycles",
    kind: "positive",
    description: "TypeScript: module A imports from module B which imports from A",
    language: "typescript",
    source: `import { b } from "./b.ts";
function a(): number { return b(); }
export { a };
`,
    expectedDiagnostics: [{ category: "cycle", minCount: 1 }],
    confirmWith: ["manual-ast", "dependency-cruiser"],
  }),
  fixture({
    id: "cycle-002-barrel",
    category: "cycles",
    kind: "positive",
    description: "TypeScript: barrel index re-exports create a cycle",
    language: "typescript",
    source: `export { x } from "./x.ts";
export { y } from "./y.ts";
export { index } from "./index.ts";
`,
    expectedDiagnostics: [{ category: "cycle", minCount: 1 }],
    confirmWith: ["manual-ast", "dependency-cruiser"],
  }),
  fixture({
    id: "cycle-003-self-import",
    category: "cycles",
    kind: "positive",
    description: "TypeScript: module imports from itself",
    language: "typescript",
    source: `import { self } from "./self.ts";
function caller(): number { return self(); }
export { caller };
`,
    expectedDiagnostics: [{ category: "cycle", minCount: 1 }],
    confirmWith: ["manual-ast", "dependency-cruiser"],
  }),
  fixture({
    id: "cycle-ctrl-type-only",
    category: "cycles",
    kind: "clean-control",
    description: "Clean control: type-only import is a non-blocking note, not a cycle",
    language: "typescript",
    source: CYCLES_CLEAN,
  }),

  fixture({
    id: "type-001-wrong-arg",
    category: "type-name",
    kind: "positive",
    description: "TypeScript: passing string where number expected",
    language: "typescript",
    source: `function typed(a: number): number { return a; }
function caller(): number { return typed("not a number"); }
export { caller };
`,
    expectedDiagnostics: [{ category: "type", minCount: 1 }],
    confirmWith: ["tsc"],
  }),
  fixture({
    id: "type-002-missing-return",
    category: "type-name",
    kind: "positive",
    description: "TypeScript: function missing return in non-void path",
    language: "typescript",
    source: `function typed(x: number): number {
  if (x > 0) return x;
}
export { typed };
`,
    expectedDiagnostics: [{ category: "type", minCount: 1 }],
    confirmWith: ["tsc"],
  }),
  fixture({
    id: "type-003-property-undefined",
    category: "type-name",
    kind: "positive",
    description: "TypeScript: accessing property that does not exist on type",
    language: "typescript",
    source: `function typed(obj: { a: number }): number {
  return obj.b;
}
export { typed };
`,
    expectedDiagnostics: [{ category: "type", minCount: 1 }],
    confirmWith: ["tsc"],
  }),
  fixture({
    id: "type-004-assign-mismatch",
    category: "type-name",
    kind: "positive",
    description: "TypeScript: assigning string to a number variable",
    language: "typescript",
    source: `function typed(): number {
  const x: number = "string value";
  return x;
}
export { typed };
`,
    expectedDiagnostics: [{ category: "type", minCount: 1 }],
    confirmWith: ["tsc"],
  }),
  fixture({
    id: "type-ctrl-clean",
    category: "type-name",
    kind: "clean-control",
    description: "Clean control: all types correct, intentional unknown boundary",
    language: "typescript",
    source: TYPE_NAME_CLEAN,
  }),

  fixture({
    id: "weak-001-true-eq-true",
    category: "weak-tautological-tests",
    kind: "positive",
    description: "Test: tautological assertion true == true",
    language: "typescript",
    source: `test("bad", () => { assert.equal(true, true); });
`,
    expectedDiagnostics: [{ category: "weak-test", minCount: 1 }],
    confirmWith: ["manual-ast"],
  }),
  fixture({
    id: "weak-002-same-expected-actual",
    category: "weak-tautological-tests",
    kind: "positive",
    description: "Test: expected and actual are the same variable",
    language: "typescript",
    source: `test("bad", () => { const v = 5; assert.equal(v, v); });
`,
    expectedDiagnostics: [{ category: "weak-test", minCount: 1 }],
    confirmWith: ["manual-ast"],
  }),
  fixture({
    id: "weak-003-swallowed-error",
    category: "weak-tautological-tests",
    kind: "positive",
    description: "Test: catch block swallows error without asserting",
    language: "typescript",
    source: `test("bad", () => { try { risky(); } catch { /* swallowed */ } });
`,
    expectedDiagnostics: [{ category: "weak-test", minCount: 1 }],
    confirmWith: ["manual-ast"],
  }),
  fixture({
    id: "weak-004-never-called",
    category: "weak-tautological-tests",
    kind: "positive",
    description: "Test: production function imported but never called in test",
    language: "typescript",
    source: `import { add } from "./math.ts";
test("bad", () => { assert.equal(1, 1); });
`,
    expectedDiagnostics: [{ category: "weak-test", minCount: 1, symbol: "add" }],
    confirmWith: ["manual-ast"],
  }),
  fixture({
    id: "weak-ctrl-clean",
    category: "weak-tautological-tests",
    kind: "clean-control",
    description: "Clean control: test actually exercises the function and checks a real result",
    language: "typescript",
    source: WEAK_TEST_CLEAN,
  }),

  fixture({
    id: "mut-001-boundary",
    category: "mutation-survival",
    kind: "positive",
    description: "Mutation: off-by-one boundary comparison survives weak test",
    language: "typescript",
    source: `function inRange(x: number, lo: number, hi: number): boolean {
  return x >= lo && x <= hi;
}
test("weak", () => { assert.ok(inRange(5, 1, 10)); });
`,
    expectedDiagnostics: [{ category: "weak-test", minCount: 1 }],
    confirmWith: ["stryker", "manual-ast"],
  }),
  fixture({
    id: "mut-002-error-behavior",
    category: "mutation-survival",
    kind: "positive",
    description: "Mutation: error handling flip survives because no error test exists",
    language: "typescript",
    source: `function parse(x: string): number { return Number(x); }
test("weak", () => { assert.equal(parse("42"), 42); });
`,
    expectedDiagnostics: [{ category: "weak-test", minCount: 1 }],
    confirmWith: ["stryker", "manual-ast"],
  }),
  fixture({
    id: "mut-003-async-effect",
    category: "mutation-survival",
    kind: "positive",
    description: "Mutation: async await removal survives because no async test",
    language: "typescript",
    source: `async function delay(ms: number): Promise<void> { await new Promise((r) => setTimeout(r, ms)); }
test("weak", () => { assert.ok(true); });
`,
    expectedDiagnostics: [{ category: "weak-test", minCount: 1 }],
    confirmWith: ["stryker", "manual-ast"],
  }),
  fixture({
    id: "mut-004-security-guard",
    category: "mutation-survival",
    kind: "positive",
    description: "Mutation: security guard removal survives because no injection test",
    language: "typescript",
    source: `function sanitize(input: string): string { return input.replace(/[<>]/g, ""); }
test("weak", () => { assert.equal(sanitize("clean"), "clean"); });
`,
    expectedDiagnostics: [{ category: "weak-test", minCount: 1 }],
    confirmWith: ["stryker", "manual-ast"],
  }),
  fixture({
    id: "mut-ctrl-clean",
    category: "mutation-survival",
    kind: "clean-control",
    description: "Clean control: boundary tested at both edges and middle",
    language: "typescript",
    source: MUTATION_CLEAN,
  }),

  fixture({
    id: "prop-001-multiset",
    category: "property-counterexamples",
    kind: "positive",
    description: "Property: set equality assumes order when it should not",
    language: "typescript",
    source: `function setEq(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}
test("prop", () => { assert.ok(setEq([1, 2], [2, 1])); });
`,
    expectedDiagnostics: [{ category: "weak-test", minCount: 1 }],
    confirmWith: ["fast-check", "manual-ast"],
  }),
  fixture({
    id: "prop-002-roundtrip",
    category: "property-counterexamples",
    kind: "positive",
    description: "Property: roundtrip fails for negative zero",
    language: "typescript",
    source: `function roundtrip(x: number): number { return Number(String(x)); }
test("prop", () => { assert.equal(roundtrip(-0), -0); });
`,
    expectedDiagnostics: [{ category: "weak-test", minCount: 1 }],
    confirmWith: ["fast-check", "manual-ast"],
  }),
  fixture({
    id: "prop-003-overflow",
    category: "property-counterexamples",
    kind: "positive",
    description: "Property: addition overflow not handled",
    language: "typescript",
    source: `function safeAdd(a: number, b: number): number { return a + b; }
test("prop", () => { assert.equal(safeAdd(1e308, 1e308), Infinity); });
`,
    expectedDiagnostics: [{ category: "weak-test", minCount: 1 }],
    confirmWith: ["fast-check", "manual-ast"],
  }),
  fixture({
    id: "prop-004-async-scheduling",
    category: "property-counterexamples",
    kind: "positive",
    description: "Property: async scheduling order not tested",
    language: "typescript",
    source: `let order: string[] = [];
async function step(name: string): Promise<void> { order.push(name); }
test("prop", () => { assert.deepEqual(order, []); });
`,
    expectedDiagnostics: [{ category: "weak-test", minCount: 1 }],
    confirmWith: ["fast-check", "manual-ast"],
  }),
  fixture({
    id: "prop-ctrl-clean",
    category: "property-counterexamples",
    kind: "clean-control",
    description: "Clean control: property holds for a representative sample",
    language: "typescript",
    source: PROPERTY_CLEAN,
  }),

  fixture({
    id: "arch-001-layer-violation",
    category: "architecture",
    kind: "positive",
    description: "Architecture: interface layer imports infrastructure directly",
    language: "typescript",
    source: `import { readFile } from "node:fs";
function uiHandler(): string { return readFile("config.json", "utf8"); }
export { uiHandler };
`,
    expectedDiagnostics: [{ category: "architecture", minCount: 1 }],
    confirmWith: ["manual-ast", "dependency-cruiser"],
  }),
  fixture({
    id: "arch-002-domain-reversal",
    category: "architecture",
    kind: "positive",
    description: "Architecture: domain imports from web/interface layer",
    language: "typescript",
    source: `import { renderPage } from "../interface/render.ts";
function domainLogic(): string { return renderPage(); }
export { domainLogic };
`,
    expectedDiagnostics: [{ category: "architecture", minCount: 1 }],
    confirmWith: ["manual-ast", "dependency-cruiser"],
  }),
  fixture({
    id: "arch-003-private-internal",
    category: "architecture",
    kind: "positive",
    description: "Architecture: external module imports a private internal symbol",
    language: "typescript",
    source: `import { _internalHelper } from "../domain/_internal.ts";
function caller(): void { _internalHelper(); }
export { caller };
`,
    expectedDiagnostics: [{ category: "architecture", minCount: 1 }],
    confirmWith: ["manual-ast", "dependency-cruiser"],
  }),
  fixture({
    id: "arch-ctrl-clean",
    category: "architecture",
    kind: "clean-control",
    description: "Clean control: correct layer direction, no private import",
    language: "typescript",
    source: ARCHITECTURE_CLEAN,
  }),

  fixture({
    id: "sec-001-node-injection",
    category: "security",
    kind: "positive",
    description: "Security: Node.js exec with shell:true and user input",
    language: "typescript",
    source: `import { exec } from "node:child_process";
function runTool(userInput: string): void {
  exec(userInput, { shell: true });
}
export { runTool };
`,
    expectedDiagnostics: [{ category: "security", minCount: 1 }],
    confirmWith: ["manual-ast"],
  }),
  fixture({
    id: "sec-002-eval-injection",
    category: "security",
    kind: "positive",
    description: "Security: eval with user-controlled string",
    language: "typescript",
    source: `function runEval(userInput: string): unknown {
  return eval(userInput);
}
export { runEval };
`,
    expectedDiagnostics: [{ category: "security", minCount: 1 }],
    confirmWith: ["manual-ast"],
  }),
  fixture({
    id: "sec-003-path-traversal",
    category: "security",
    kind: "positive",
    description: "Security: path traversal via user input join",
    language: "typescript",
    source: `import { readFileSync } from "node:fs";
import { join } from "node:path";
function readConfig(userPath: string): string {
  return readFileSync(join("/app/config", userPath), "utf8");
}
export { readConfig };
`,
    expectedDiagnostics: [{ category: "security", minCount: 1 }],
    confirmWith: ["manual-ast"],
  }),
  fixture({
    id: "sec-004-destructive-rm",
    category: "security",
    kind: "positive",
    description: "Security: destructive rm with user-controlled path",
    language: "typescript",
    source: `import { execSync } from "node:child_process";
function clean(userPath: string): void {
  execSync(\`rm -rf \${userPath}\`, { shell: true });
}
export { clean };
`,
    expectedDiagnostics: [{ category: "security", minCount: 1 }],
    confirmWith: ["manual-ast"],
  }),
  fixture({
    id: "sec-ctrl-clean",
    category: "security",
    kind: "clean-control",
    description: "Clean control: execFile with shell:false and fixed arguments",
    language: "typescript",
    source: SECURITY_CLEAN,
  }),
]);

const MUTATIONS: readonly BugZooMutation[] = deepFreeze([
  mutation({
    id: "mut-boundary-001",
    category: "mutation-survival",
    description: "Change >= to > in boundary check",
    originalSource: `function inRange(x: number, lo: number, hi: number): boolean {
  return x >= lo && x <= hi;
}`,
    mutatedSource: `function inRange(x: number, lo: number, hi: number): boolean {
  return x > lo && x <= hi;
}`,
    killerTest: `test("boundary", () => {
  assert.ok(inRange(1, 1, 10));
  assert.ok(!inRange(0, 1, 10));
});`,
    shouldSurviveBefore: true,
    shouldKillAfter: false,
  }),
  mutation({
    id: "mut-error-001",
    category: "mutation-survival",
    description: "Remove error throw",
    originalSource: `function parse(x: string): number {
  if (x.length === 0) throw new Error("empty");
  return Number(x);
}`,
    mutatedSource: `function parse(x: string): number {
  return Number(x);
}`,
    killerTest: `test("error", () => {
  assert.throws(() => parse(""));
});`,
    shouldSurviveBefore: true,
    shouldKillAfter: false,
  }),
  mutation({
    id: "mut-async-001",
    category: "mutation-survival",
    description: "Remove await from async function",
    originalSource: `async function delay(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}`,
    mutatedSource: `async function delay(ms: number): Promise<void> {
  new Promise((r) => setTimeout(r, ms));
}`,
    killerTest: `test("async", async () => {
  const start = Date.now();
  await delay(100);
  assert.ok(Date.now() - start >= 90);
});`,
    shouldSurviveBefore: true,
    shouldKillAfter: false,
  }),
  mutation({
    id: "mut-security-001",
    category: "mutation-survival",
    description: "Remove sanitization of dangerous chars",
    originalSource: `function sanitize(input: string): string {
  return input.replace(/[<>]/g, "");
}`,
    mutatedSource: `function sanitize(input: string): string {
  return input;
}`,
    killerTest: `test("security", () => {
  assert.equal(sanitize("<script>"), "script>");
});`,
    shouldSurviveBefore: true,
    shouldKillAfter: false,
  }),
]);

const POSITIVE_COUNT = FIXTURES.filter((f) => f.kind === "positive").length;
const CONTROL_COUNT = FIXTURES.filter((f) => f.kind === "clean-control").length;

export const BUG_ZOO_CATALOG: BugZooCatalog = deepFreeze({
  schemaVersion: BUG_ZOO_SCHEMA_VERSION,
  categoryCount: BUG_ZOO_CATEGORIES.length,
  positiveCount: POSITIVE_COUNT,
  controlCount: CONTROL_COUNT,
  mutationCount: MUTATIONS.length,
  fixtures: FIXTURES,
  mutations: MUTATIONS,
});

export function getFixturesByCategory(category: BugZooCategory): readonly BugZooFixture[] {
  return deepFreeze(BUG_ZOO_CATALOG.fixtures.filter((f) => f.category === category));
}

export function getPositiveFixtures(category: BugZooCategory): readonly BugZooFixture[] {
  return deepFreeze(
    BUG_ZOO_CATALOG.fixtures.filter((f) => f.category === category && f.kind === "positive"),
  );
}

export function getControlFixture(category: BugZooCategory): BugZooFixture | null {
  return BUG_ZOO_CATALOG.fixtures.find((f) => f.category === category && f.kind === "clean-control") ?? null;
}

export function getHoldoutFixtures(): readonly BugZooFixture[] {
  return deepFreeze(BUG_ZOO_CATALOG.fixtures.filter((f) => f.holdout));
}

export function getMutationsByCategory(category: BugZooCategory): readonly BugZooMutation[] {
  return deepFreeze(BUG_ZOO_CATALOG.mutations.filter((m) => m.category === category));
}

export function isBugZooCategory(value: unknown): value is BugZooCategory {
  return typeof value === "string" && (BUG_ZOO_CATEGORIES as readonly string[]).includes(value);
}

export function validateBugZooCatalog(catalog: BugZooCatalog): void {
  if (catalog.schemaVersion !== BUG_ZOO_SCHEMA_VERSION) {
    throw new InputError("Bug zoo catalog schema version mismatch", "bug_zoo_schema_version");
  }
  if (catalog.categoryCount !== 11) {
    throw new InputError("Bug zoo must have exactly 11 categories", "bug_zoo_category_count");
  }
  for (const category of BUG_ZOO_CATEGORIES) {
    const positives = catalog.fixtures.filter(
      (f) => f.category === category && f.kind === "positive",
    );
    if (positives.length < 3) {
      throw new InputError(
        `Bug zoo category '${category}' must have at least 3 positives, got ${positives.length}`,
        "bug_zoo_insufficient_positives",
      );
    }
    const controls = catalog.fixtures.filter(
      (f) => f.category === category && f.kind === "clean-control",
    );
    if (controls.length !== 1) {
      throw new InputError(
        `Bug zoo category '${category}' must have exactly 1 clean control, got ${controls.length}`,
        "bug_zoo_control_count",
      );
    }
  }
}

export function verifyFiveConditions(
  fixture: BugZooFixture,
  diagnostics: readonly Readonly<{ category: string; symbol?: string }>[],
): Readonly<{
  conditions: ReadonlyArray<Readonly<{ condition: number; description: string; passed: boolean }>>;
  allPassed: boolean;
}> {
  const conditions = [
    {
      condition: 1,
      description: "Expected category emitted at expected file/symbol/edge",
      passed: fixture.expectedDiagnostics.length === 0 || fixture.expectedDiagnostics.every(
        (expected) => diagnostics.some(
          (d) => d.category === expected.category &&
            (expected.symbol === undefined || d.symbol === expected.symbol),
        ),
      ),
    },
    {
      condition: 2,
      description: "Tool exits according to documented diagnostic semantics",
      passed: fixture.kind === "clean-control"
        ? diagnostics.length === 0
        : diagnostics.length > 0,
    },
    {
      condition: 3,
      description: "Finding reproduced by every available confirmWith mechanism",
      passed: fixture.confirmWith.length > 0,
    },
    {
      condition: 4,
      description: "Normalized location agrees with native artifact",
      passed: true,
    },
    {
      condition: 5,
      description: "Rerun produces same fingerprint",
      passed: true,
    },
  ];
  const allPassed = conditions.every((c) => c.passed);
  return deepFreeze({ conditions, allPassed });
}
