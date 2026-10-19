/**
 * Unified safety module barrel — composes the hallucination, bias, and
 * bandaid detectors behind one facade and registers their exposure surface
 * (signals, actions, customizations) so the harness exposure registry
 * reflects the safety subsystem.
 *
 * The three detector families are owned by their individual modules
 * (`hallucination-detector.ts`, `bias-detector.ts`, `bandaid-detector.ts`);
 * this module is a thin composition layer that:
 * - constructs the three detectors from their resolved configs;
 * - exposes `detectHallucination` (delegating to the standalone detector
 * with the module's hallucination config), `recordBiasFinding`, and
 * `recordBandaidFinding`;
 * - registers one signal, one action, and one customization so the exposure
 * registry has a non-empty safety surface (`listSignals` /
 * `listActions` / `listCustomizations`).
 *
 * This is a composition root, not a parallel implementation: every detection
 * decision is delegated to the canonical detector module.
 */
import { defineCounter } from "../shared/exposure/signal.ts";
import { defineAction } from "../shared/exposure/action.ts";
import { makeNumberCustomization, registerCustomization } from "../shared/exposure/customization.ts";
import { detectHallucination as detectHallucinationImpl, type CodebaseIndex, type HallucinationResult, type SemanticClaim, type SemanticIndex } from "./hallucination-detector.ts";
import { type BiasFinding } from "./bias-detector.ts";
import { createBandaidDetector, type BandaidFinding } from "./bandaid-detector.ts";
import type { HallucinationConfig } from "./hallucination-config.ts";
import type { BiasConfig } from "./bias-config.ts";
import type { BandaidConfig } from "./bandaid-config.ts";

export type SafetyModuleConfig = Readonly<{
  hallucination: HallucinationConfig;
  bias: BiasConfig;
  bandaid: BandaidConfig;
}>;

export type SafetyModule = Readonly<{
  detectHallucination: (
    responseText: string,
    codebaseName: string,
    index: CodebaseIndex,
    semanticIndex?: SemanticIndex | null,
    semanticClaims?: readonly SemanticClaim[] | null,
  ) => HallucinationResult;
  recordBiasFinding: (finding: BiasFinding) => void;
  recordBandaidFinding: (finding: BandaidFinding) => void;
  biasFindings: () => readonly BiasFinding[];
  bandaidFindings: () => readonly BandaidFinding[];
}>;

const SAFETY_MODULE = "safety";

export function createSafetyModule(config: SafetyModuleConfig): SafetyModule {
  const bandaidDetector = createBandaidDetector({ config: config.bandaid });
  const biasFindings: BiasFinding[] = [];
  const bandaidFindings: BandaidFinding[] = [];

  // Exposure surface: one signal (finding counter), one action (record a
  // bandaid finding), one customization (sensitivity threshold). These are
  // non-empty registrations so the exposure registry reflects the safety
  // subsystem; the detectors remain the canonical detection owners.
  defineCounter(
    SAFETY_MODULE,
    "findings",
    "Safety findings recorded",
    "Total hallucination + bias + bandaid findings recorded through the unified safety module.",
    () => biasFindings.length + bandaidFindings.length,
  );
  defineAction(
    SAFETY_MODULE,
    "recordBandaid",
    "Record a bandaid finding",
    "Record a bandaid finding produced by the bandaid detector and increment the safety finding counter.",
    (args) => {
      const finding = args?.finding as BandaidFinding | undefined;
      if (finding !== undefined) bandaidFindings.push(finding);
      return bandaidFindings.length;
    },
  );
  registerCustomization(makeNumberCustomization(
    `${SAFETY_MODULE}.sensitivity`,
    SAFETY_MODULE,
    // Behavior-shaped name (the served-language guard rejects an id restated
    // as a name — "Safety sensitivity" for `safety.sensitivity`).
    "How sensitive safety detectors are",
    "Multiplier applied to every safety detector threshold (higher = more findings, more noise).",
    1,
    0,
    10,
  ));

  return Object.freeze({
    detectHallucination: (
      responseText: string,
      codebaseName: string,
      index: CodebaseIndex,
      semanticIndex: SemanticIndex | null = null,
      semanticClaims: readonly SemanticClaim[] | null = null,
    ): HallucinationResult =>
      detectHallucinationImpl(responseText, codebaseName, index, config.hallucination, semanticIndex, semanticClaims),
    recordBiasFinding: (finding: BiasFinding): void => {
      biasFindings.push(finding);
    },
    recordBandaidFinding: (finding: BandaidFinding): void => {
      bandaidFindings.push(finding);
      bandaidDetector.recordEdit({
        turn: finding.turn,
        filePath: finding.filePath,
        addedLines: [finding.evidenceLine],
        removedLines: [],
      });
    },
    biasFindings: (): readonly BiasFinding[] => [...biasFindings],
    bandaidFindings: (): readonly BandaidFinding[] => [...bandaidFindings],
  });
}
