/**
 * Shared exposure registrations — `timeline` module.
 *
 * The recorded ledger's operational knobs. The engine's timeline config
 * section (engine/src/kernel/config-contracts.ts) declares the values; the
 * server's own accessors (server/kernel/harness-config.ts) read the SAME
 * paths live per call — so this registration publishes PRESENTATION only
 * (label, description, effect timing): `current` reads through the config
 * store and `set` writes through the config write gate, never a second
 * source of truth.
 */

import {
  registerCustomization,
  registerExposureModule,
  registerSignal,
} from "../index.ts";
import { readBooleanCustomization, writeConfigCustomization } from "../config-binding.ts";
import { DEFAULT_CAPTURE_PROVIDER_PAYLOADS } from "../../../kernel/config-contracts.ts";

/** The ledger's readiness as the host that opens it reads it (SCALE-CR1 C10). */
export type TimelineReadinessFacts = Readonly<{ state: string; pendingMigrations: readonly string[]; since: string }>;
let readinessSource: (() => TimelineReadinessFacts) | null = null;

/** Install the live reading of the ledger's readiness (the web server, at boot). */
export function installTimelineReadinessSource(source: () => TimelineReadinessFacts): void {
  readinessSource = source;
}

/** Register the timeline module's settings. Idempotent. */
let timelineRegistered = false;
export function registerTimelineExposure(): void {
  if (timelineRegistered) return;
  timelineRegistered = true;

  registerExposureModule({
    id: "timeline",
    title: "The recorded ledger",
    purpose:
      "What the harness keeps a permanent record of: how much each recorded interaction may hold, and whether the exact words sent to a model are kept beside the run.",
  });

  registerSignal({
    id: "timeline.readiness",
    module: "timeline",
    name: "Ledger readiness",
    description:
      "Whether the ledger is open for recording: ready; migrating (it owed schema migrations, which run off the serving thread while the server answers — what needs the ledger is told to retry); failed (a migration was refused; the reason is logged); or unopened.",
    type: "string",
    value: () => {
      const facts = readinessSource?.();
      if (facts === undefined) return "unmeasured";
      return facts.pendingMigrations.length === 0 ? facts.state : `${facts.state} since ${facts.since} (${facts.pendingMigrations.join(", ")})`;
    },
  });

  // --- Signals (1) ---
  // The knob's own live state, served as a signal — the same mirror pattern
  // as `safety.groundingEnabled` / `tools.failClosed`, and the `measuredBy`
  // target the customization below declares so an instrument cell gains its
  // adjust verb mechanically.
  registerSignal({
    id: "timeline.captureProviderPayloads",
    module: "timeline",
    name: "Keeping what the model was sent",
    description:
      "Whether the exact (redacted) request messages and assembled response are kept as ledger documents on each provider call.",
    type: "boolean",
    value: () => readBooleanCustomization("timeline.captureProviderPayloads", DEFAULT_CAPTURE_PROVIDER_PAYLOADS),
  });

  // --- Customizations (1) ---
  // Read by the provider sink at every provider event it records, so a change
  // lands on the very next recorded call — which is what `immediate` states.
  registerCustomization({
    id: "timeline.captureProviderPayloads",
    module: "timeline",
    name: "Keep what the model was sent and answered",
    description:
      "On: every provider call keeps its (redacted) request messages and assembled response in the ledger, so you can ask later what the model actually received. Off: provider calls keep their timing and outcome only, and the ledger stays metadata-only.",
    type: "boolean",
    default: DEFAULT_CAPTURE_PROVIDER_PAYLOADS,
    current: () => readBooleanCustomization("timeline.captureProviderPayloads", DEFAULT_CAPTURE_PROVIDER_PAYLOADS),
    set: (v) => writeConfigCustomization("timeline.captureProviderPayloads", v),
    contract: { effect: "immediate" },
    measuredBy: "timeline.captureProviderPayloads",
    configPath: "timeline.captureProviderPayloads",
  });
}

/** Reset the per-module registration flag (test-only). */
export function resetTimelineRegistration(): void {
  timelineRegistered = false;
}
