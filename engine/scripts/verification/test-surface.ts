import { z } from "zod";

import { canonicalHash, deepFreeze, type DeepReadonly } from "../../src/kernel/integrity.ts";
import { HarnessError } from "../../src/kernel/errors.ts";
import { compareUtf8Bytes } from "../../src/kernel/ordered.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
// THE MANIFEST HAS ONE OWNER, AND IT IS NOT HERE. What a disposition entry
// is, how a path is recognized and qualified, and the two doors that sign and
// verify the manifest live in the runtime layer so `harness regenerate` can
// use them too. It used to carry an inlined copy with a raw `JSON.parse` that
// rewrote `policyHash` unconditionally — one writer that could re-bless a pin
// is one refusal that cannot hold.
import {
  createTestSurfaceDispositionManifest,
  isQualifiedCanonicalNodeTestSource,
  isScannedRecognizableTestSource,
  NONEMPTY_STRING,
  parseTestSurfaceDispositionManifest,
  parseTestSurfaceDispositionManifestText,
  QUALIFIED_TEST_SOURCE_MATCHERS,
  recognizableTestSourceLanguage,
  type TestSurfaceDispositionEntry,
  type TestSurfaceDispositionManifest,
} from "../../src/kernel/test-surface-manifest.ts";
import { deadPatterns, patternLivenessFailure } from "./pattern-liveness.ts";

// Re-exported because every existing consumer of the test surface imports it
// from here, and a move that renames 15 call sites is a move that gets a
// spelling wrong somewhere. The owner is the module above; this is a door,
// not a second definition.
export {
  createTestSurfaceDispositionManifest,
  isQualifiedCanonicalNodeTestSource,
  isScannedRecognizableTestSource,
  parseTestSurfaceDispositionManifest,
  parseTestSurfaceDispositionManifestText,
  recognizableTestSourceLanguage,
};
export type { TestSurfaceDispositionEntry, TestSurfaceDispositionManifest };

const DISCOVERY = ROOT_POLICY.verification.testDiscovery;


export const TEST_SURFACE_SCOPE_SCHEMA = z.strictObject({
  dispositionManifestHash: z.string().regex(/^[0-9a-f]{64}$/u),
  canonicalNodeSourceIds: z.array(NONEMPTY_STRING),
  qualifiedExternalSourceIds: z.array(NONEMPTY_STRING),
  pendingExternalSourceIds: z.array(NONEMPTY_STRING),
  nonTestFixtureSourceIds: z.array(NONEMPTY_STRING),
  unsupportedSourceIds: z.array(NONEMPTY_STRING),
  recognizableSurfaceDispositionCoverageComplete: z.literal(true),
  canonicalNodeInventorySourceSetComplete: z.literal(true),
  fullRepositoryTestQualificationComplete: z.boolean(),
});

export type TestSurfaceScope = DeepReadonly<z.infer<typeof TEST_SURFACE_SCOPE_SCHEMA>>;



/**
 * REFUSAL — every declared qualified pattern must match at least one file.
 *
 * `qualifiedSourcePatterns` decides what RUNS. Renaming `test/` to `tests/`
 * makes the glob rooted at `test/` match nothing; the other two entries are
 * single file literals and still match, so the canonical set collapses to two while
 * every count stays internally consistent and the run reports passing.
 *
 * A pattern that matches nothing is not a narrow pattern, it is a broken one.
 * This is per-pattern on purpose: a whole-set liveness check is satisfied by
 * the two literals, which is exactly the state the catastrophe produces.
 *
 * Judged against the GIT-TRACKED recognizable set, not against the walk: the
 * walk is filtered by the same policy that holds the patterns, so asking it
 * whether the patterns are live is asking the policy about itself.
 *
 * ── BUT THE GIT SET IS NOT THE POPULATION THIS QUESTION IS ABOUT ─────────
 *
 * The independence argument above is right and the FILTER that came with it
 * was not. `gitTrackedRecognizableTestPaths` applies only the two
 * `recognizableSourcePatterns` regexes, so the set it returns includes 21
 * files the suite can never run — experiment trees and excluded directories
 * that the walk drops. Twelve of them sit under `test/`, so
 * `test/**` + '/' + `*.test.ts` keeps matching against them no matter what
 * happens to the files that actually run.
 *
 * Driven: a population consisting ENTIRELY of never-run excluded files left
 * this refusal silent — the refusal that fired was a different one, about the
 * pins. A liveness check a dead population satisfies is not liveness.
 *
 * So the paths are filtered by the same per-path rule the walk applies before
 * the patterns are judged. The instrument stays the git index; only the
 * question is corrected, from "does this pattern match a tracked file" to
 * "does this pattern match a file that would be RUN".
 */
function assertEveryQualifiedPatternIsLive(recognizablePaths: readonly string[]): void {
  const runnablePaths = recognizablePaths.filter(isScannedRecognizableTestSource);
  // THE RULE COMES FROM THE SHARED OWNER, not from a second copy of it here.
  // Three declarations across the two repositories now need "which of these
  // declared patterns matched nothing" — this one, the tsconfig `include`
  // lists, and the test runner's globs — and the half that is agnostic
  // (which patterns are dead, and what the operator must be told) lives in
  // `pattern-liveness.ts`. Only the half that is SPECIFIC stays here: how a
  // pattern is matched (regexes, against the git-derived runnable set) and
  // which error this repository raises.
  const matches = DISCOVERY.qualifiedSourcePatterns.map((pattern, index) => ({
    pattern,
    matched: runnablePaths.filter((path) => QUALIFIED_TEST_SOURCE_MATCHERS[index]!.test(path)).length,
  }));
  // AND THE WORDING COMES FROM THE OWNER TOO. The rule was shared and the
  // MESSAGE was still written twice — §2 at half strength, and the half that
  // drifts fastest, because a sentence has no compiler. `patternLivenessFailure`
  // already says which patterns died, how many files the survivors still
  // select (the number that makes a total-count floor pass over a dead
  // pattern), and what an operator must do about it. What stays local is the
  // half that genuinely is: WHERE the declaration lives and which error this
  // repository raises.
  const failure = patternLivenessFailure(
    `the qualified test-source patterns in root-policy.ts, against the files the suite would run`,
    matches,
  );
  if (failure !== null) {
    throw new HarnessError(
      `${failure} ${runnablePaths.length} runnable recognizable sources were offered ` +
      `(${recognizablePaths.length} git-tracked, before the walk's own exclusions).`,
      "qualified_test_pattern_dead",
      false,
      {
        deadPatterns: deadPatterns(matches).join(","),
        recognizableCount: runnablePaths.length,
      },
    );
  }
}

/**
 * REFUSAL — the conservation identity, and the two pinned sets it rests on.
 *
 * `gitRecognizablePaths` MUST come from the git index, which no value in
 * `root-policy.ts` can influence. That independence is the whole mechanism:
 * every other quantity here is derived from the same policy that would be
 * wrong, so comparing them to each other proves only that they are
 * consistently wrong. See the long note at
 * `ROOT_POLICY.verification.testDiscovery.surfaceConservation`.
 *
 * Pure over its two arguments so a planted violation costs a synthetic
 * argument and no mutation of the tree — and note that a caller cannot defeat
 * it by supplying an empty population, because the pinned terms are constants
 * and the identity then fails by construction.
 *
 * This is the ONE door. `buildTestSurfaceScope` is a pure projection of a
 * manifest and is deliberately used with synthetic single-file inputs by test
 * fixtures, so a refusal placed there would be a refusal about a fixture. All
 * four refusals live here, at the single call the production inventory
 * generator makes, so there is one place to look and one place to bypass.
 */
export type TestSurfaceConservationReceipt = Readonly<{
  gitRecognizableCount: number;
  excludedCount: number;
  nonCanonicalCount: number;
  canonicalCount: number;
}>;

export function assertTestSurfaceConservation(
  gitRecognizablePaths: readonly string[],
  scope: TestSurfaceScope,
): TestSurfaceConservationReceipt {
  const pins = DISCOVERY.surfaceConservation;
  assertEveryQualifiedPatternIsLive(gitRecognizablePaths);
  const registryPaths = [
    ...scope.canonicalNodeSourceIds,
    ...scope.qualifiedExternalSourceIds,
    ...scope.pendingExternalSourceIds,
    ...scope.nonTestFixtureSourceIds,
    ...scope.unsupportedSourceIds,
  ];
  const registrySet = new Set(registryPaths);
  const gitSet = new Set(gitRecognizablePaths);

  // REFUSAL — the five buckets must PARTITION the registry: every path in
  // exactly one of them, exactly once.
  //
  // ── WHY THIS IS A REAL CHECK AND NOT BOOKKEEPING ────────────────────────
  //
  // Everything below counts `registryPaths`, an ARRAY, while the subset
  // argument that justifies the arithmetic is about `registrySet`, a SET. The
  // two differ exactly when a path appears more than once, and driven against
  // the live scope the consequences were not symmetric:
  //
  //   duplicate a canonical path INSIDE `canonicalNodeSourceIds`
  //       → the arithmetic identity fired, and nothing else did;
  //   put a canonical path ALSO in `nonTestFixtureSourceIds`
  //       → NOTHING fired. All four refusals passed.
  //
  // One shape caught, its sibling missed — which is worse than catching
  // neither, because the identity's own note claimed the arithmetic "CANNOT
  // fail" and the pair together advertised coverage that did not exist.
  // `parseTestSurfaceScope` rejects both shapes, but this function takes a
  // `TestSurfaceScope` as a plain structural argument and a caller that builds
  // one by hand never went through that door.
  //
  // With this check in place the claim below is finally true in both
  // directions, and it is true BECAUSE of this, not by assumption.
  const duplicated = [...new Set(
    registryPaths.filter((path, index) => registryPaths.indexOf(path) !== index),
  )].toSorted(compareUtf8Bytes);
  if (duplicated.length > 0) {
    throw new HarnessError(
      `the test-surface registry does not partition its ${registryPaths.length} entries: ` +
      `${duplicated.length} path(s) appear more than once, first ${duplicated[0]}. A path in two ` +
      `buckets — or twice in one — is counted twice by every quantity derived from the registry, ` +
      `so the excluded set, the non-canonical set and the conservation identity all describe a ` +
      `surface that does not exist. Each source has exactly one disposition.`,
      "test_surface_registry_not_partitioned",
      false,
      { duplicateCount: duplicated.length, firstDuplicate: duplicated[0] ?? "", registryCount: registryPaths.length },
    );
  }

  // The registry may never name a file git does not hold: without this the
  // "excluded" difference below could be made to balance by inventing paths.
  const untracked = registryPaths.filter((path) => !gitSet.has(path)).toSorted(compareUtf8Bytes);
  if (untracked.length > 0) {
    throw new HarnessError(
      `test-surface registry names ${untracked.length} source(s) git does not track: ` +
      `${untracked.slice(0, 10).join(", ")}. A clone does not contain them, so the suite a clone runs ` +
      `is not the suite this manifest describes.`,
      "test_surface_registry_untracked",
      false,
      { untrackedCount: untracked.length, firstUntracked: untracked[0] ?? "" },
    );
  }

  const excluded = gitRecognizablePaths
    .filter((path) => !registrySet.has(path))
    .toSorted(compareUtf8Bytes);
  const nonCanonical = registryPaths
    .filter((path) => !scope.canonicalNodeSourceIds.includes(path))
    .toSorted(compareUtf8Bytes);

  assertPinnedSet("excluded", excluded, pins.excludedSourceSet, "surfaceConservation.excludedSourceSet");
  assertPinnedSet("non-canonical", nonCanonical, pins.nonCanonicalSourceSet, "surfaceConservation.nonCanonicalSourceSet");

  // ── THE IDENTITY, AND AN HONEST NOTE ABOUT WHAT IT DOES ─────────────────
  //
  // This is the arithmetic the three refusals above exist to protect, and it
  // is written out because it is the sentence a reader needs. It is NOT an
  // independent detector, and pretending otherwise would be the decorative
  // shape this whole file is against.
  //
  // Given the FOUR checks already passed — the registry partitions its
  // entries, every registry path is tracked, the excluded set matches its pin,
  // the non-canonical set matches its pin — this line cannot fail:
  // |git| = |excluded| + |registry| by the subset check, and
  // |canonical| = |registry| − |nonCanonical| by construction, so
  // |git| − |excluded| − |nonCanonical| = |canonical| identically.
  //
  // THE PARTITION CHECK IS LOAD-BEARING IN THAT SENTENCE, and it was added
  // because without it the sentence was FALSE IN BOTH DIRECTIONS. Driven: a
  // canonical path duplicated inside its own bucket made this line the SOLE
  // detector — so "cannot fail" was wrong — while the same path duplicated
  // ACROSS two buckets fired nothing at all, so the coverage it advertised was
  // also wrong. Both shapes are now refused above, by name, before anything
  // derived from the registry is measured.
  //
  // This stays as a tripwire on the four above: weaken the subset check or
  // drop a pin and it becomes live again, loudly, instead of the whole
  // mechanism quietly becoming a tautology with nothing left to notice. The
  // pinned SIZES are used deliberately — recomputing both sides would make it
  // a tautology under any population, including a collapsed one.
  const required = gitRecognizablePaths.length - pins.excludedSourceSet.count - pins.nonCanonicalSourceSet.count;
  const actual = scope.canonicalNodeSourceIds.length;
  if (required !== actual) {
    const direction = required > actual
      ? "test sources stopped being run and nothing else said so; check whether a directory moved out from " +
        "under the qualified source patterns in root-policy.ts"
      : "sources started being run; if that is intended, re-pin the two sets in root-policy.ts";
    throw new HarnessError(
      "test-surface conservation identity does not balance: " +
      `${gitRecognizablePaths.length} git-tracked recognizable minus ${pins.excludedSourceSet.count} pinned ` +
      `excluded minus ${pins.nonCanonicalSourceSet.count} pinned non-canonical is ${required}, but ${actual} ` +
      `sources are canonical. Difference ${Math.abs(required - actual)}: ${direction}.`,
      "test_surface_conservation_broken",
      false,
      { gitRecognizable: gitRecognizablePaths.length, required, actual },
    );
  }
  // THE RECEIPT IS WHY THIS RETURNS A VALUE INSTEAD OF `void`.
  //
  // Measured: with `void`, wrapping this call in `try { … } catch {}` at the
  // production door let `harness regenerate` exit 0 with a deliberately
  // broken pin. Every structural check still passed — the import was there,
  // the call was there — because a swallowed refusal and a satisfied one look
  // identical from outside. The receipt is evidence only a CONSUMED refusal
  // can produce, and the snapshot the inventory is built from requires it, so
  // discarding it is a compile error rather than a silent regression.
  return deepFreeze({
    gitRecognizableCount: gitRecognizablePaths.length,
    excludedCount: excluded.length,
    nonCanonicalCount: nonCanonical.length,
    canonicalCount: actual,
  });
}

function assertPinnedSet(
  label: string,
  actual: readonly string[],
  pin: Readonly<{ count: number; sha256: string }>,
  pinLocation: string,
): void {
  const actualHash = canonicalHash(actual);
  if (actual.length === pin.count && actualHash === pin.sha256) return;
  const sameSize = actual.length === pin.count ? " (same size, different members)" : "";
  throw new HarnessError(
    `the pinned ${label} test-source set moved: ${pin.count} pinned, ${actual.length} measured${sameSize}. ` +
    `If the change is intended, restate ${pinLocation} in root-policy.ts with count ${actual.length} ` +
    `and sha256 ${actualHash}. This pin is deliberately not auto-repaired: ` +
    "a pin a generator can rewrite refuses nothing.",
    "test_surface_pinned_set_moved",
    false,
    { label, pinnedCount: pin.count, measuredCount: actual.length, measuredSha256: actualHash },
  );
}

export function buildTestSurfaceScope(
  recognizablePaths: readonly string[],
  manifestValue: unknown,
): TestSurfaceScope {
  const manifest = parseTestSurfaceDispositionManifest(manifestValue);
  const expected = [...new Set(recognizablePaths)].toSorted(compareUtf8Bytes);
  if (expected.length !== recognizablePaths.length ||
    expected.some((path) => recognizableTestSourceLanguage(path) === undefined)) {
    throw new Error("recognizable test-surface input is invalid");
  }
  const actual = manifest.entries.map((entry) => entry.path);
  if (canonicalHash(expected) !== canonicalHash(actual)) {
    throw new Error("test-surface disposition coverage is incomplete");
  }
  const byDisposition = (disposition: TestSurfaceDispositionEntry["disposition"]): readonly string[] =>
    manifest.entries.filter((entry) => entry.disposition === disposition).map((entry) => entry.path);
  const pendingExternalSourceIds = byDisposition("pending-external-qualification");
  const unsupportedSourceIds = byDisposition("unsupported-blocking");
  return parseTestSurfaceScope({
    dispositionManifestHash: manifest.integrityHash,
    canonicalNodeSourceIds: byDisposition("canonical-node-test"),
    qualifiedExternalSourceIds: byDisposition("qualified-external-oracle"),
    pendingExternalSourceIds,
    nonTestFixtureSourceIds: byDisposition("non-test-fixture"),
    unsupportedSourceIds,
    recognizableSurfaceDispositionCoverageComplete: true,
    canonicalNodeInventorySourceSetComplete: true,
    fullRepositoryTestQualificationComplete:
      pendingExternalSourceIds.length === 0 && unsupportedSourceIds.length === 0,
  });
}

export function parseTestSurfaceScope(value: unknown): TestSurfaceScope {
  const scope = TEST_SURFACE_SCOPE_SCHEMA.parse(value);
  const groups = [
    scope.canonicalNodeSourceIds,
    scope.qualifiedExternalSourceIds,
    scope.pendingExternalSourceIds,
    scope.nonTestFixtureSourceIds,
    scope.unsupportedSourceIds,
  ];
  const combined = groups.flat();
  if (groups.some((group) =>
    canonicalHash(group) !== canonicalHash([...new Set(group)].toSorted(compareUtf8Bytes))
  ) ||
    new Set(combined).size !== combined.length ||
    scope.fullRepositoryTestQualificationComplete !==
      (scope.pendingExternalSourceIds.length === 0 && scope.unsupportedSourceIds.length === 0)) {
    throw new Error("test-surface scope projection is invalid");
  }
  return deepFreeze(scope);
}
