/**
 * Frontend accessor for the `webUi.graph` + `webUi.metrics` +
 * `artifacts` config sections.
 *
 * Single client-side owner of web-UI tunable reads. The dependency-graph force layout, the
 * metrics poll cadence, and the artifact iframe sandbox token read their
 * values from the redacted config snapshot served by GET /api/config (the
 * same `configSnapshot` store the rest of the UI uses). The server-side
 * authority is `server/harness-config.ts` (`getGraphConfig` /
 * `getMetricsConfig` / `getArtifactIframeSandbox`); these fallbacks mirror
 * the server defaults so a missing/partial config behaves identically on
 * both sides.
 *
 * Plain.ts — Node-testable via Vitest. The pure `readGraphConfig` /
 * `readMetricsConfig` / `readArtifactSandboxToken` helpers take a raw config
 * object so tests can exercise every fallback branch without a live config
 * store.
 */

import { computed, type ReadableAtom } from "nanostores";

import { configSnapshot } from "./config-snapshot";
import { rejectSameOrigin } from "../../shared/html-preview";

// SPO: `GraphConfig` + `MetricsConfig` are owned by
// `shared/wire-types.ts` (single wire-shape owner — the redacted config
// snapshot shape). Re-exported here so existing
// `import { type GraphConfig } from "./state/web-ui-config"` paths are
// unchanged.
import type { GraphConfig, MetricsConfig, PerformanceBudgetConfig } from "../../shared/wire-types";
export type { GraphConfig, MetricsConfig };
/** Re-exported for any future client-side consumer of the performance budget
 * (the regression gate reads the SERVER accessor). Type-only — zero runtime
 * cost. */
export type { PerformanceBudgetConfig };

// The DEFAULT_* tables, the `asPositiveInt`/`asPositiveNumber` coercers and
// the pure `readGraphConfig`/`readMetricsConfig` readers were MOVED to
// `shared/web-ui-defaults.ts` — the seam BOTH sides compile against.
// This file previously carried a byte-identical copy of the 30-key
// `DEFAULT_GRAPH_CONFIG` table that also lives in `server/harness-config.ts`;
// two copies of one table is a single-source-of-truth violation that a drift
// test can only detect after the fact. Now there is one declaration and two
// importers. Re-exported here so every existing
// `from "./state/web-ui-config"` import path is unchanged.
export {
  asPositiveInt,
  asPositiveNumber,
  readGraphConfig,
  readMetricsConfig,
} from "../../shared/web-ui-defaults";
import { readGraphConfig, readMetricsConfig, DEFAULT_ARTIFACT_SANDBOX } from "../../shared/web-ui-defaults";

/** The graph config derived from the live config snapshot (reactive). */
export const graphConfig: ReadableAtom<GraphConfig> = computed(configSnapshot, (snap) => {
  const cfg = (snap as Readonly<Record<string, unknown>> | null)?.config as Readonly<Record<string, unknown>> | undefined;
  return readGraphConfig(cfg ?? null);
});

/** The metrics config derived from the live config snapshot (reactive). */
export const metricsConfig: ReadableAtom<MetricsConfig> = computed(configSnapshot, (snap) => {
  const cfg = (snap as Readonly<Record<string, unknown>> | null)?.config as Readonly<Record<string, unknown>> | undefined;
  return readMetricsConfig(cfg ?? null);
});

// ── Artifact iframe sandbox token ──
// The chat's live artifact renderer (ArtifactView) runs untrusted LLM-built
// HTML in a sandboxed iframe. The sandbox TOKEN (which capabilities the
// iframe gets) comes from `artifacts.iframeSandbox` in the harness config.
// The single client-side owner of that read lives HERE (SPO): the
// component does NOT read the config inline — it consumes the reactive
// `artifactSandboxToken` atom. This is the "Lowest-Level Enforcement"
// pattern: the config owner reads + HARDENS the token once (via the shared
// security owner `rejectSameOrigin` from html-preview.ts), so no consumer
// can forget to strip `allow-same-origin` (which would let an artifact read
// the parent's DOM/cookies/localStorage). The server-side authority is
// `getArtifactIframeSandbox` in harness-config.ts; both read the SAME
// `DEFAULT_ARTIFACT_SANDBOX` constant from `shared/web-ui-defaults.ts`
// (the two sides no longer each spell out the `"allow-scripts"` literal).

/** Read the `artifacts.iframeSandbox` config value with the default fallback
 * + the `rejectSameOrigin` security hardening (the shared security owner in
 * html-preview.ts). Pure: takes a raw config object so tests can exercise
 * every branch (absent section / empty string / allow-same-origin / custom)
 * without a live config store. Returns a token that is ALWAYS safe for an
 * untrusted-HTML iframe (never contains `allow-same-origin`). */
export function readArtifactSandboxToken(config: Readonly<Record<string, unknown>> | null | undefined): string {
  const artifacts = config?.artifacts as Readonly<Record<string, unknown>> | undefined;
  const raw = typeof artifacts?.iframeSandbox === "string" && artifacts.iframeSandbox.length > 0
    ? artifacts.iframeSandbox
    : DEFAULT_ARTIFACT_SANDBOX;
  return rejectSameOrigin(raw);
}

/** The artifact iframe sandbox token derived from the live config snapshot
 * (reactive). Hardened by `rejectSameOrigin` so a misconfigured
 * `allow-same-origin` can never reach an untrusted-HTML iframe. Consumed by
 * ArtifactView (the single artifact renderer) — the component never reads
 * the config inline (SPO: one config owner). */
export const artifactSandboxToken: ReadableAtom<string> = computed(configSnapshot, (snap) => {
  const cfg = (snap as Readonly<Record<string, unknown>> | null)?.config as Readonly<Record<string, unknown>> | undefined;
  return readArtifactSandboxToken(cfg ?? null);
});

// ── Prompt generator (config-driven option catalog) ──
// The Settings "Prompt generator" panel composes a system prompt from a set
// of selectable options (role / tone / output format / language + checkbox
// constraints). The OPTION CATALOG lives in `webUi.promptGenerator` in the
// harness config (single source of truth); the builder composition is a pure
// function (the old tree's prompt builder, deleted at the cutover — the
// catalog remains the server-side truth). Both sides (server
// `getPromptGeneratorConfig` + this reader) share the same defaults so a
// missing/partial section behaves identically — the harness-config-webui
// contract test asserts no drift.

export type PromptGeneratorOption = Readonly<{
  readonly id: string;
  readonly label: string;
  readonly instruction: string;
}>;

export type PromptGeneratorConfig = Readonly<{
  readonly roles: readonly PromptGeneratorOption[];
  readonly tones: readonly PromptGeneratorOption[];
  readonly outputFormats: readonly PromptGeneratorOption[];
  readonly languages: readonly PromptGeneratorOption[];
  readonly constraints: readonly PromptGeneratorOption[];
}>;

const DEFAULT_PROMPT_GENERATOR_CONFIG: PromptGeneratorConfig = {
  roles: [],
  tones: [],
  outputFormats: [],
  languages: [],
  constraints: [],
};
Object.freeze(DEFAULT_PROMPT_GENERATOR_CONFIG);

/** Coerce one option object into a validated PromptGeneratorOption (or drop). */
function coerceOption(v: unknown): PromptGeneratorOption | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const id = o["id"];
  const label = o["label"];
  const instruction = o["instruction"];
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof label !== "string" || label.length === 0) return null;
  if (typeof instruction !== "string" || instruction.length === 0) return null;
  return Object.freeze({ id, label, instruction });
}

function coerceOptionList(v: unknown): readonly PromptGeneratorOption[] {
  if (!Array.isArray(v)) return [];
  const out: PromptGeneratorOption[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    const opt = coerceOption(item);
    // Dedup by id (a duplicate id would produce ambiguous <option> values).
    if (opt !== null && !seen.has(opt.id)) {
      seen.add(opt.id);
      out.push(opt);
    }
  }
  return Object.freeze(out);
}

/** Read the `webUi.promptGenerator` section from a raw config object with defaults. */
export function readPromptGeneratorConfig(config: Readonly<Record<string, unknown>> | null | undefined): PromptGeneratorConfig {
  const webUi = config?.webUi as Readonly<Record<string, unknown>> | undefined;
  const pg = webUi?.promptGenerator as Readonly<Record<string, unknown>> | undefined;
  if (pg === undefined) return DEFAULT_PROMPT_GENERATOR_CONFIG;
  return {
    roles: coerceOptionList(pg.roles),
    tones: coerceOptionList(pg.tones),
    outputFormats: coerceOptionList(pg.outputFormats),
    languages: coerceOptionList(pg.languages),
    constraints: coerceOptionList(pg.constraints),
  };
}

/** The prompt-generator config derived from the live config snapshot (reactive). */
export const promptGeneratorConfig: ReadableAtom<PromptGeneratorConfig> = computed(configSnapshot, (snap) => {
  const cfg = (snap as Readonly<Record<string, unknown>> | null)?.config as Readonly<Record<string, unknown>> | undefined;
  return readPromptGeneratorConfig(cfg ?? null);
});
