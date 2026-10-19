/**
 * Shared exposure registrations — `artifacts` module.
 *
 * Interactive chat artifacts (LLM-created apps rendered in a sandboxed
 * iframe) already live in `artifacts.*` and are read live by
 * `getArtifactMaxBytes` / `getArtifactIframeSandbox` / `getArtifactIdLength`.
 * This file publishes those knobs onto the settings surface.
 */

import {
  registerCustomization,
  registerExposureModule,
  readConfigCustomization,
  readNumberCustomization,
  writeConfigCustomization,
  type CustomizationValue,
} from "../index.ts";

const DEFAULTS = {
  maxBytes: 524_288,
  iframeSandbox: "allow-scripts",
  idLength: 16,
} as const;

function readStr(configPath: string, fallback: string): CustomizationValue {
  const value = readConfigCustomization(configPath);
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

let artifactsRegistered = false;
export function registerArtifactsExposure(): void {
  if (artifactsRegistered) return;
  artifactsRegistered = true;

  registerExposureModule({
    id: "artifacts",
    title: "Live previews the assistant builds in chat",
    purpose:
      "How large a generated preview may be, which powers the preview frame is allowed, and how long its identifier is.",
  });

  registerCustomization({
    id: "artifacts.maxBytes",
    module: "artifacts",
    name: "Largest preview the assistant may create",
    description:
      "A generated preview larger than this many bytes is refused so a runaway page cannot fill the store. Raising it allows richer previews and costs more memory.",
    type: "number",
    default: DEFAULTS.maxBytes,
    min: 1_024,
    max: 16_777_216,
    unit: "bytes",
    current: () => readNumberCustomization("artifacts.maxBytes", DEFAULTS.maxBytes),
    set: (v) => writeConfigCustomization("artifacts.maxBytes", v),
    contract: { effect: "immediate" },
    configPath: "artifacts.maxBytes",
  });
  registerCustomization({
    id: "artifacts.iframeSandbox",
    module: "artifacts",
    name: "Powers the preview frame is allowed",
    description:
      "The preview frame is granted only these sandbox tokens. Scripts may run; do not add same-origin access, which would let untrusted preview code read this page.",
    type: "string",
    default: DEFAULTS.iframeSandbox,
    current: () => readStr("artifacts.iframeSandbox", DEFAULTS.iframeSandbox),
    set: (v) => writeConfigCustomization("artifacts.iframeSandbox", v),
    contract: { effect: "immediate" },
    configPath: "artifacts.iframeSandbox",
  });
  registerCustomization({
    id: "artifacts.idLength",
    module: "artifacts",
    name: "Characters kept from a preview's fingerprint",
    description:
      "The stable identifier shown for a preview is this many hex characters of its content fingerprint. Raising it (up to 64) makes collisions rarer and the id longer to read.",
    type: "number",
    default: DEFAULTS.idLength,
    min: 4,
    max: 64,
    unit: "characters",
    current: () => readNumberCustomization("artifacts.idLength", DEFAULTS.idLength),
    set: (v) => writeConfigCustomization("artifacts.idLength", v),
    contract: { effect: "immediate" },
    configPath: "artifacts.idLength",
  });
}

export function resetArtifactsRegistration(): void {
  artifactsRegistered = false;
}
