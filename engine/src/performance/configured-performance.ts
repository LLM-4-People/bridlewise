import { loadPinnedConfigSnapshot } from "../kernel/config.ts";
import { DEFAULT_PERFORMANCE_CONFIG, parsePerformanceConfig, type PerformanceConfig } from "./performance-config.ts";

/**
 * A document's `performance` section, parsed — an undeclared section is the
 * declared default. THE one resolution every reader applies, whichever config
 * door handed it the section: the engine CLI (`configuredPerformanceConfig`
 * below) and the web server (`configuredPerformance`), whose metrics collector
 * ran on the frozen defaults and ignored the operator's section (CFG-0 B4).
 *
 * It lives here, not beside the default in `performance-config.ts`: that
 * module hands its default out to the settings room and the tests, and a
 * module that both declares and resolves a default may not export it
 * (test/prevention/resolved-default-not-readable.test.ts).
 */
export function performanceConfigOf(section: unknown): PerformanceConfig {
  return parsePerformanceConfig(section ?? DEFAULT_PERFORMANCE_CONFIG);
}

/**
 * The document's `performance` section, parsed — the ONE reader every
 * performance command uses (`harness diagnostic`, `harness benchmark`,
 * `harness metrics`). A document the loader refuses propagates (see
 * `loadPinnedConfigSnapshotIfPresent` in kernel/config.ts for why a refusal is
 * never answered with defaults).
 *
 * Lives beside, not inside, `performance-config.ts`: the config contracts
 * import that module, so the loader importing back would be a cycle.
 */
export function configuredPerformanceConfig(): PerformanceConfig {
  return performanceConfigOf(loadPinnedConfigSnapshot().document.performance);
}
