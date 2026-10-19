/**
 * Test-coverage proxy — test files / source files.
 *
 * The user directive includes "test coverage proxy" as a codebase
 * awareness signal. We approximate by counting files whose path/name
 * matches a test pattern (test, spec, _test,.test.,.spec.) and
 * dividing by the number of source files. This is a ratio, not a
 * real coverage measurement (which would require running tests).
 *
 * The signal emits:
 * - testFileCount: number of test files.
 * - sourceFileCount: number of non-test source files.
 * - ratio: testFileCount / sourceFileCount (0 = no tests; >1 = more
 * tests than sources).
 * - testLoc: total lines in test files.
 * - sourceLoc: total lines in source files.
 * - testDensity: testLoc / (testLoc + sourceLoc).
 */
import type { SignalContext } from "../types.ts";
import { round } from "../../shared/numeric-helpers.ts";

const TEST_RE = /(^|\/|_)(test|spec)(s|_|\.|$)|\.test\.|\.spec\.|_test\.|_spec\./i;

export function computeTestCoverage(ctx: SignalContext) {
  let testFileCount = 0;
  let sourceFileCount = 0;
  let testLoc = 0;
  let sourceLoc = 0;
  for (const fa of ctx.fileAnalyses) {
    if (TEST_RE.test(fa.filePath)) {
      testFileCount += 1;
      testLoc += fa.lineCount;
    } else {
      sourceFileCount += 1;
      sourceLoc += fa.lineCount;
    }
  }
  const ratio = sourceFileCount > 0 ? testFileCount / sourceFileCount : 0;
  const testDensity = testLoc + sourceLoc > 0 ? testLoc / (testLoc + sourceLoc) : 0;
  return {
    testCoverage: {
      testFileCount,
      sourceFileCount,
      ratio: round(ratio, 4),
      testLoc,
      sourceLoc,
      testDensity: round(testDensity, 4),
    },
  };
}
