import { deepFreeze } from "../kernel/integrity.ts";

/**
 * Hallucination detection configuration — single source of truth.
 *
 * Seven detection layers (EXP354/388, EXP447 adds L7 SEMANTIC):
 * L1. WHITELIST — system prompt scoped to the codebase index.
 * L2. STRUCTURED — LLM response must match the expected JSON schema.
 * L3. GROUNDING — every reference (symbol/path/import) must exist.
 * L4. PRE-EMPTIVE — partial streaming output is validated mid-stream.
 * L5. POST-HOC — full output is re-scanned after completion.
 * L6. AUTO-CORRECT — Levenshtein-distance symbol repair + signature repair.
 * L7. SEMANTIC — verify LLM CLAIMS about function semantics (return
 * type, parameter names, async-ness, line number,
 * thrown exceptions, class membership) against an
 * enriched AST-extracted semantic index. Closes the
 * EXP354 67% semantic-miss gap (EXP388: 0% miss).
 *
 * Per binding directive "everything dynamically computed, no static
 * variables/consts": every threshold, regex, and allowlist lives here.
 * The detector implementations never hardcode a value.
 */
export const HALLUCINATION_LAYERS = deepFreeze([
  "whitelist",
  "structured",
  "grounding",
  "pre-emptive",
  "post-hoc",
  "auto-correct",
  "semantic",
] as const);

export type HallucinationLayer = typeof HALLUCINATION_LAYERS[number];

/** Reference categories the grounding layer extracts + checks. */
const REFERENCE_KINDS = deepFreeze([
  "function",
  "import",
  "export",
  "path",
  "type",
  "env",
  "string",
] as const);

export type ReferenceKind = typeof REFERENCE_KINDS[number];

/** Semantic claim fields the L7 SEMANTIC layer verifies (EXP388). */
const SEMANTIC_CLAIM_FIELDS = deepFreeze([
  "returns",
  "params",
  "async",
  "line",
  "throws",
  "className",
  "isDefault",
  "argCount",
] as const);

export type SemanticClaimField = typeof SEMANTIC_CLAIM_FIELDS[number];

export type HallucinationConfig = Readonly<{
  /** Per-layer enable flags. */
  layers: Readonly<Record<HallucinationLayer, boolean>>;
  /** Maximum Levenshtein distance for auto-correction. */
  autoCorrectLevenshteinThreshold: number;
  /** Maximum number of auto-corrections per response before blocking. */
  autoCorrectMaxCorrections: number;
  /** Maximum number of references to extract from one response (DoS guard). */
  maxReferencesPerResponse: number;
  /** Whether to extract string literals as references. */
  detectStringReferences: boolean;
  /** File extensions considered as path references. */
  pathExtensions: readonly string[];
  /** Built-in identifiers that always pass the grounding check. */
  builtinAllowlist: readonly string[];
  /** Maximum turns of consecutive failures before blocking the session. */
  maxConsecutiveFailures: number;
  // ---- L7 SEMANTIC (EXP388 / EXP447) ----
  /** Whether to infer claims from code shape (await X → async claim, etc.). */
  semanticInferClaims: boolean;
  /** Whether to also correct arg-count + param-name mismatches (not just names). */
  semanticAutoCorrectSignature: boolean;
  /** Normalized type strings above this Jaccard are treated as equal (loose type match). */
  semanticTypeSimilarityThreshold: number;
  /** Allow line-number claims within this absolute tolerance (off-by-one guard). */
  semanticLineTolerance: number;
  /** Maximum number of semantic claims to extract per response (DoS guard). */
  maxSemanticClaimsPerResponse: number;
}>;

export const HALLUCINATION_DEFAULT_CONFIG: HallucinationConfig = deepFreeze({
  layers: {
    whitelist: true,
    structured: true,
    grounding: true,
    "pre-emptive": true,
    "post-hoc": true,
    "auto-correct": true,
    semantic: true,
  },
  autoCorrectLevenshteinThreshold: 3,
  autoCorrectMaxCorrections: 5,
  maxReferencesPerResponse: 500,
  detectStringReferences: false,
  pathExtensions: [".ts", ".js", ".mjs", ".cjs", ".json", ".tsx", ".jsx", ".md", ".py", ".rs", ".go", ".java"],
  builtinAllowlist: [
    "Math", "Object", "Array", "JSON", "Promise", "String", "Number", "Boolean",
    "RegExp", "Date", "Map", "Set", "WeakMap", "WeakSet", "Symbol", "Error",
    "TypeError", "RangeError", "SyntaxError", "ReferenceError", "URIError",
    "EvalError", "console", "process", "Buffer", "globalThis", "global",
    "setTimeout", "setInterval", "clearTimeout", "clearInterval", "setImmediate",
    "clearImmediate", "queueMicrotask", "fetch", "require", "module", "exports",
    "__dirname", "__filename", "AbortController", "AbortSignal", "URL", "URLSearchParams",
    "TextEncoder", "TextDecoder", "crypto", "navigator", "document", "window",
    "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent",
    "decodeURIComponent", "encodeURI", "decodeURI",
  ],
  maxConsecutiveFailures: 3,
  semanticInferClaims: true,
  semanticAutoCorrectSignature: true,
  semanticTypeSimilarityThreshold: 0.6,
  semanticLineTolerance: 0,
  maxSemanticClaimsPerResponse: 100,
});

/** Resolve a caller's partial config against defaults. */
export function resolveHallucinationConfig(
  override: Readonly<Partial<HallucinationConfig>> = {},
): HallucinationConfig {
  const layers: Record<HallucinationLayer, boolean> = {
    ...HALLUCINATION_DEFAULT_CONFIG.layers,
    ...(override.layers ?? {}),
  };
  return {
    ...HALLUCINATION_DEFAULT_CONFIG,
    ...override,
    layers,
  };
}
