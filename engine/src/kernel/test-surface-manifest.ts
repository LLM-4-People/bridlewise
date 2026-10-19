import { z } from "zod";

import { canonicalHash, deepFreeze } from "./integrity.ts";
import { HarnessError } from "./errors.ts";
import { assertNoDuplicateJsonObjectKeys } from "./json-integrity.ts";
import { compareUtf8Bytes } from "./ordered.ts";
import { relativePathViolationKinds } from "../filesystem/path-boundary.ts";
import { ROOT_POLICY } from "./root-policy.ts";
import { shouldExcludeExperiment } from "../shared/source-scan.ts";

/**
 * THE TEST-SURFACE DISPOSITION MANIFEST — ONE OWNER, ONE WRITER.
 *
 * ── WHY THIS FILE EXISTS AT ALL ───────────────────────────────────────────
 *
 * This manifest is a PIN. It records which recognizable test source is
 * canonical, which is a fixture, which is unsupported — and its `policyHash`
 * ties that record to the discovery policy the record was made under. When a
 * directory is renamed, the stale `policyHash` is one of the eight refusals
 * that stop a suite from silently running a smaller set of tests than it
 * claims.
 *
 * There were TWO writers. The builder-layer verification module had the
 * schema-validated one; `harness regenerate` carried an inlined copy that
 * parsed the manifest with a raw `JSON.parse`, checked two fields by hand,
 * and rewrote `policyHash` UNCONDITIONALLY from the current policy. That
 * second writer was the reason a stale-policy refusal could be walked past:
 * a pin a generator can silently re-bless refuses nothing.
 *
 * Its own comment said why it was a copy — importing the builder module would
 * put `src/ → scripts/` into the runtime import graph, which the architecture
 * forbids. The reason was true and the conclusion was not: the shared half
 * depends on NOTHING in the builder layer. Every input it needs — the schema
 * library, canonical hashing, the error type, duplicate-key detection, byte
 * ordering, path-boundary validation and the root policy — already lives in
 * the runtime layer. So the half both callers need moved DOWN to where both
 * may import it, rather than being copied sideways.
 *
 * ── WHAT IS HERE, AND WHAT DELIBERATELY IS NOT ────────────────────────────
 *
 * Here: what a disposition entry IS, what a manifest IS, how a path is
 * recognized and qualified, and the only two doors — `create…` (which signs)
 * and `parse…` (which verifies). Both go through the same schema, so there is
 * no shape a writer can produce that a reader would not accept, and no field
 * a writer can set that the schema does not declare.
 *
 * Not here: the CONSERVATION identity, the pinned-set refusals and the scope
 * projection. Those are checks a builder performs about the repository, not
 * facts about the manifest, and they stay in the verification module beside
 * the rest of the build-time verification.
 *
 * ── THE PROPERTY THAT MATTERS ─────────────────────────────────────────────
 *
 * `policyHash` is written by `createTestSurfaceDispositionManifest` and
 * verified by `parseTestSurfaceDispositionManifest`, and there is no third
 * path. A caller that wants to heal a stale integrity hash must round-trip
 * through both — so a manifest whose policy has genuinely moved on REFUSES
 * instead of being quietly re-signed, which is the whole point of pinning it.
 */
const DISCOVERY = ROOT_POLICY.verification.testDiscovery;

/**
 * THE POLICY A MANIFEST IS PINNED TO: the discovery policy WITHOUT its
 * conservation pins. The pins (`surfaceConservation`: the excluded and the
 * non-canonical sets' counts and hashes) are restated by hand when the
 * surface moves, and each is checked on every inventory run against the git
 * index by the conservation identity (scripts/verification/test-surface.ts
 * `assertTestSurfaceConservation`) — the independent check. Hashing them here
 * made every legitimate restatement stale the manifest, which needed a manual
 * re-sign door (design M4). A change to anything else — a root, a pattern, a
 * rule — still stales it, and still refuses.
 */
export function testSurfacePolicyHash(): string {
  const { surfaceConservation: _pins, ...policy } = DISCOVERY;
  return canonicalHash(policy);
}
const DISPOSITIONS = DISCOVERY.dispositionRegistry.allowedDispositions;
const RECOGNIZABLE_PATTERNS = Object.freeze({
  "javascript-typescript": new RegExp(DISCOVERY.recognizableSourcePatterns.javaScriptTypeScript, "u"),
  python: new RegExp(DISCOVERY.recognizableSourcePatterns.python, "u"),
});
/**
 * One compiled matcher per declared qualified pattern, in declaration order.
 *
 * Exported because the builder layer's per-pattern liveness refusal judges
 * these same matchers: two compilations of one declaration would be two
 * answers to one question.
 */
export const QUALIFIED_TEST_SOURCE_MATCHERS = DISCOVERY.qualifiedSourcePatterns.map(compileRestrictedTestGlob);
/** A non-empty string, shared with the scope schema in the builder layer. */
export const NONEMPTY_STRING = z.string().min(1);
const ENTRY_SCHEMA = z.strictObject({
  path: NONEMPTY_STRING.refine((path) => relativePathViolationKinds(path).length === 0),
  language: z.enum(["javascript-typescript", "python"]),
  disposition: z.enum(DISPOSITIONS),
  rationale: NONEMPTY_STRING,
  evidenceLinks: z.array(NONEMPTY_STRING),
  blocksFullRepositoryClaim: z.boolean(),
});
const MANIFEST_SCHEMA = z.strictObject({
  schemaVersion: z.literal(DISCOVERY.dispositionRegistry.schemaVersion),
  role: z.literal("complete-recognizable-test-surface-disposition"),
  policyHash: z.string().regex(/^[0-9a-f]{64}$/u),
  entries: z.array(ENTRY_SCHEMA),
  integrityHash: z.string().regex(/^[0-9a-f]{64}$/u),
});

export type TestSurfaceDispositionEntry = Readonly<z.infer<typeof ENTRY_SCHEMA>>;
export type TestSurfaceDispositionManifest = Readonly<z.infer<typeof MANIFEST_SCHEMA>>;

export function isQualifiedCanonicalNodeTestSource(path: string): boolean {
  return QUALIFIED_TEST_SOURCE_MATCHERS.some((matcher) => matcher.test(path));
}

// Foundation-cascade tests create temporary UUID-based .test.ts files in
// test/support/. These are test fixtures, not real test sources — they
// should not be registered in the inventory. This pattern matches them.
const FOUNDATION_CASCADE_RESIDUE_PATTERN =
  /test\/support\/(?:foundation-cascade|\.foundation-cascade)-[a-z-]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u;

export function recognizableTestSourceLanguage(
  path: string,
): "javascript-typescript" | "python" | undefined {
  if (relativePathViolationKinds(path).length > 0) return undefined;
  // Exclude foundation-cascade residue files (UUID-based .test.ts files
  // created by the foundation-cascade tests in test/support/).
  if (FOUNDATION_CASCADE_RESIDUE_PATTERN.test(path)) return undefined;
  for (const [language, pattern] of Object.entries(RECOGNIZABLE_PATTERNS)) {
    if (pattern.test(path)) return language as "javascript-typescript" | "python";
  }
  return undefined;
}

/**
 * IS THIS PATH A RECOGNIZABLE TEST SOURCE THAT THE SUITE CAN ACTUALLY RUN?
 *
 * The single owner of the per-path half of "in scope for the test surface".
 * `recognizableTestSourceLanguage` answers only "does this look like a test
 * source"; this adds every exclusion the repository walk applies, so the two
 * instruments that answer the same question — the walk over the disk and the
 * git index — can be filtered identically instead of by two hand-kept copies.
 *
 * The walk prunes excluded DIRECTORIES during traversal, which is a
 * performance decision; the decision itself is here, and
 * `readRecognizableTestSurface` applies this function as its final filter so
 * the walk cannot answer differently from the index. A test asserts the two
 * agree on the live tree, because "one owner" is a claim that has to be
 * measured.
 */
export function isScannedRecognizableTestSource(path: string): boolean {
  if (recognizableTestSourceLanguage(path) === undefined) return false;
  const configuration = ROOT_POLICY.configuration;
  const segments = path.split("/");
  const fileName = segments.at(-1) ?? "";
  if (segments.slice(0, -1).some((segment) =>
    (configuration.repositoryScanExclusions as readonly string[]).includes(segment))) {
    return false;
  }
  if ((configuration.repositoryScanFileExclusions as readonly string[]).includes(fileName)) return false;
  if (configuration.repositoryScanFileSuffixExclusions.some((suffix) => path.endsWith(suffix))) return false;
  return !shouldExcludeExperiment(path);
}

export function parseTestSurfaceDispositionManifestText(text: string): TestSurfaceDispositionManifest {
  assertNoDuplicateJsonObjectKeys(
    text,
    "Test-surface disposition manifest contains a duplicate key",
    "test_surface_disposition_key_duplicate",
  );
  return parseTestSurfaceDispositionManifest(JSON.parse(text) as unknown);
}

export function createTestSurfaceDispositionManifest(
  entries: readonly TestSurfaceDispositionEntry[],
): TestSurfaceDispositionManifest {
  const unsigned = {
    schemaVersion: DISCOVERY.dispositionRegistry.schemaVersion,
    role: "complete-recognizable-test-surface-disposition",
    policyHash: testSurfacePolicyHash(),
    entries: [...entries].toSorted((left, right) => compareUtf8Bytes(left.path, right.path)),
  } as const;
  return parseTestSurfaceDispositionManifest({
    ...unsigned,
    integrityHash: canonicalHash(unsigned),
  });
}

/**
 * The manifest's shape WITHOUT its signature — the only form a re-signing
 * caller may read.
 */
const UNSIGNED_MANIFEST_SCHEMA = z.strictObject({
  schemaVersion: z.literal(DISCOVERY.dispositionRegistry.schemaVersion),
  role: z.literal("complete-recognizable-test-surface-disposition"),
  policyHash: z.string().regex(/^[0-9a-f]{64}$/u),
  entries: z.array(ENTRY_SCHEMA),
  integrityHash: z.string().regex(/^[0-9a-f]{64}$/u),
});

/** The manifest as bytes, in the one format every writer of it produces. */
export function serializeTestSurfaceDispositionManifest(
  manifest: TestSurfaceDispositionManifest,
): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * RE-SIGN A MANIFEST WHOSE ENTRIES WERE EDITED BY HAND — and refuse one whose
 * POLICY has moved.
 *
 * ── THE DISTINCTION THIS FUNCTION EXISTS TO MAKE ──────────────────────────
 *
 * Two things can be stale in this file and they are not the same thing.
 *
 *   `integrityHash` goes stale when somebody edits an entry. That is an
 *   ordinary, recoverable state: the entries are still the truth, the
 *   signature simply has to be recomputed over them. Healing it is a
 *   convenience with no authority attached.
 *
 *   `policyHash` goes stale when the DISCOVERY POLICY changed — a renamed
 *   directory, an altered pattern. The manifest then records dispositions
 *   made under rules that no longer apply, and re-signing it would launder
 *   that: the pin would agree with the new policy while describing the old
 *   world. A pin a generator can silently rewrite refuses nothing.
 *
 * So this heals the first and REFUSES the second, and it re-signs through
 * `createTestSurfaceDispositionManifest` — the one writer — rather than
 * assembling the signed object itself. The entries are validated by the same
 * schema the reader uses, so a hand edit that invented a field or a
 * disposition is rejected here rather than at the next reader.
 *
 * The previous implementation of this heal lived inlined in the command
 * layer, parsed with a raw `JSON.parse`, checked two fields by hand, and set
 * `policyHash` to the CURRENT policy unconditionally. It was the only path in
 * the repository that could re-bless a stale pin.
 */
export function resignTestSurfaceDispositionManifest(text: string): Readonly<{
  status: "current" | "regenerated";
  integrityHash: string;
  text: string;
}> {
  assertNoDuplicateJsonObjectKeys(
    text,
    "Test-surface disposition manifest contains a duplicate key",
    "test_surface_disposition_key_duplicate",
  );
  const parsed = UNSIGNED_MANIFEST_SCHEMA.parse(JSON.parse(text) as unknown);
  const currentPolicyHash = testSurfacePolicyHash();
  // A STALE POLICY REFUSES: the dispositions were made under rules that no
  // longer apply (the conservation pins are not part of it: see
  // `testSurfacePolicyHash`).
  if (parsed.policyHash !== currentPolicyHash) {
    throw new HarnessError(
      "test-surface disposition manifest policyHash is stale relative to current discovery policy: the discovery " +
        "rules changed under the recorded dispositions, so they are refused, never re-signed",
      "test_surface_disposition_policy_stale",
      false,
      { manifestPolicyHash: parsed.policyHash, currentPolicyHash },
    );
  }
  for (const entry of parsed.entries) assertDispositionSemantics(entry);
  const resigned = createTestSurfaceDispositionManifest(parsed.entries);
  return deepFreeze({
    status: resigned.integrityHash === parsed.integrityHash ? "current" : "regenerated",
    integrityHash: resigned.integrityHash,
    text: serializeTestSurfaceDispositionManifest(resigned),
  });
}

export function parseTestSurfaceDispositionManifest(value: unknown): TestSurfaceDispositionManifest {
  const parsed = MANIFEST_SCHEMA.parse(value);
  if (parsed.policyHash !== testSurfacePolicyHash()) {
    throw new HarnessError(
      "test-surface disposition manifest policyHash is stale relative to current discovery policy",
      "test_surface_disposition_policy_stale",
      false,
      { manifestPolicyHash: parsed.policyHash, currentPolicyHash: testSurfacePolicyHash() },
    );
  }
  const { integrityHash, ...unsigned } = parsed;
  if (canonicalHash(unsigned) !== integrityHash) {
    throw new HarnessError(
      "test-surface disposition manifest integrity is invalid",
      "test_surface_disposition_integrity_invalid",
      false,
      { declared: integrityHash, recomputed: canonicalHash(unsigned) },
    );
  }
  const sorted = [...parsed.entries].toSorted((left, right) => compareUtf8Bytes(left.path, right.path));
  if (new Set(parsed.entries.map((entry) => entry.path)).size !== parsed.entries.length ||
    canonicalHash(sorted) !== canonicalHash(parsed.entries)) {
    throw new HarnessError(
      "test-surface disposition entries are duplicated or unordered",
      "test_surface_disposition_entries_unordered",
      false,
      { entryCount: String(parsed.entries.length) },
    );
  }
  for (const entry of parsed.entries) assertDispositionSemantics(entry);
  return deepFreeze(parsed) as TestSurfaceDispositionManifest;
}

function assertDispositionSemantics(entry: TestSurfaceDispositionEntry): void {
  const language = recognizableTestSourceLanguage(entry.path);
  if (language === undefined || language !== entry.language) {
    throw new HarnessError(
      `test-surface disposition language is invalid: ${entry.path}`,
      "test_surface_disposition_language_invalid",
      false,
      { path: entry.path, declared: entry.language, recognized: language ?? "none" },
    );
  }
  const qualified = isQualifiedCanonicalNodeTestSource(entry.path);
  if (entry.disposition === "canonical-node-test" && (!qualified ||
    entry.language === "python")) {
    throw new HarnessError(
      `test-surface canonical disposition is invalid: ${entry.path}`,
      "test_surface_disposition_canonical_invalid",
      false,
      { path: entry.path, language: entry.language },
    );
  }
  const blocks = entry.disposition === "pending-external-qualification" ||
    entry.disposition === "unsupported-blocking";
  if (entry.blocksFullRepositoryClaim !== blocks) {
    throw new HarnessError(
      `test-surface claim blocking is invalid: ${entry.path}`,
      "test_surface_disposition_claim_blocking_invalid",
      false,
      { path: entry.path, disposition: entry.disposition },
    );
  }
  if ((entry.disposition === "qualified-external-oracle" || entry.disposition === "non-test-fixture") &&
    entry.evidenceLinks.length === 0) {
    throw new HarnessError(
      `test-surface disposition evidence is missing: ${entry.path}`,
      "test_surface_disposition_evidence_missing",
      false,
      { path: entry.path, disposition: entry.disposition },
    );
  }
}

function compileRestrictedTestGlob(pattern: string): RegExp {
  if (pattern.startsWith("/") || pattern.includes("\\") ||
    relativePathViolationKinds(pattern.replaceAll("*", "x")).length > 0 || /[?\[\]{}]/u.test(pattern)) {
    throw new HarnessError(
      `unsupported qualified test-source pattern: ${pattern}`,
      "qualified_test_pattern_unsupported",
      false,
      { pattern },
    );
  }
  const segments = pattern.split("/");
  let source = "^";
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (segment === "**") {
      source += "(?:[^/]+/)*";
      continue;
    }
    source += segment.split("*").map(escapeRegExp).join("[^/]*");
    if (index < segments.length - 1) source += "/";
  }
  return new RegExp(`${source}$`, "u");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+^${}()|[\]\\]/gu, "\\$&");
}
