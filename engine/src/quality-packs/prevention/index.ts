/**
 * Barrel re-export for the prevention detectors (D3). Named exports only,
 * per the index-exports convention. ONE source of truth per detector,
 * consumed by both the harness's own `test/prevention/*.test.ts` AND the
 * model-facing `src/quality-packs/typescript-pack.ts` (D4).
 */

export {
  astNode,
  astNodeArray,
  astChildren,
  bindingNames,
  babelParserPluginsForSourcePath,
  type AstNode,
  type BabelParserPlugin,
} from "./ast-helpers.ts";
export {
  detectDuplicateBodies,
  detectDuplicateBodiesWithPass3,
  computeBodyHashes,
  type DuplicateBodyFinding,
  type DuplicateBodyAllowlistCross,
  type DuplicateBodyAllowlistSameFile,
  type DuplicateBodyOptions,
  type DuplicateBodyResult,
  type DuplicateBodyEmbeddingPass3Options,
  type BodyHashEntry,
} from "./duplicate-body-detector.ts";
export {
  getEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderOptions,
  type EmbeddingVector,
} from "./embedding-provider.ts";
export {
  detectEsmCjsMismatches,
  type EsmCjsFinding,
  type EsmCjsFindingKind,
  type EsmCjsOptions,
} from "./esm-cjs-detector.ts";
export {
  detectDuplicatedLiterals,
  type DuplicatedLiteralFinding,
  type DuplicatedLiteralOptions,
  type DuplicatedLiteralResult,
  type LiteralConcept,
  type LiteralPosition,
} from "./duplicated-literals-detector.ts";
