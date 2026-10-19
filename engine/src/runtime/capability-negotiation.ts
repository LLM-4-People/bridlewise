import { InputError } from "../kernel/errors.ts";
import {
  CAPABILITY_NEGOTIATION_SCHEMA,
  CAPABILITY_OFFER_SCHEMA,
  CAPABILITY_REQUIREMENT_SCHEMA,
  type CapabilityName,
  type CapabilityNegotiation,
  type CapabilityOffer,
  type CapabilityRequirement,
  type ContractSettings,
  type ModelRequest,
} from "../kernel/contracts.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";

const PROTOCOL_MCP = ROOT_POLICY.contracts.protocolIds[2] as "mcp-2025-11-25";

export const CAPABILITY_NEGOTIATION_REVISION = "capability-negotiation/v1";

export function deriveCapabilityRequirement(request: ModelRequest): CapabilityRequirement {
  // DELIBERATE SUBSET: 1 of 8 CapabilityName members. This is an ACCUMULATOR,
  // not a vocabulary — `"text"` is the floor every request needs and the
  // branches below add the rest from the request itself. It is declared here
  // rather than exempted by shape: the guard used to treat "this identifier is
  // pushed to somewhere in the file" as a silent exemption, and that test read
  // raw bytes, so a `required.push(` written only inside a comment or only
  // inside a string silenced it. Both were driven. One declared mechanism is
  // better than a second undeclared one.
  const required: CapabilityName[] = ["text"];
  if (request.stream) required.push("streaming");
  if (request.tools.length > 0) required.push("tools");
  if (request.parallelToolCalls && request.tools.length > 0) required.push("parallel_tool_calls");
  if (request.toolChoice === "required") required.push("tool_choice_required");
  if (request.reasoningEffort !== undefined) required.push("reasoning");
  return deepFreeze(CAPABILITY_REQUIREMENT_SCHEMA.parse({ required, preferred: ["usage"] }));
}

export function negotiateCapabilities(
  requirementInput: CapabilityRequirement,
  offerInputs: readonly CapabilityOffer[],
  settings: ContractSettings,
): CapabilityNegotiation {
  const requirement = CAPABILITY_REQUIREMENT_SCHEMA.parse(requirementInput);
  const offers = offerInputs.map((offer) => CAPABILITY_OFFER_SCHEMA.parse(offer));
  assertUnique(requirement.required, "capability_requirement_duplicate");
  assertUnique(requirement.preferred, "capability_preference_duplicate");
  assertUnique(offers.map((offer) => offer.protocol), "capability_offer_protocol_duplicate");
  for (const offer of offers) assertUnique(offer.supported, "capability_offer_duplicate");

  const enabledModelProtocols = [
    settings.preferredModelProtocol,
    ...settings.enabledProtocols.filter((protocol) =>
      protocol !== settings.preferredModelProtocol && protocol !== PROTOCOL_MCP
    ),
  ];
  const byProtocol = new Map(offers.map((offer) => [offer.protocol, offer]));
  const candidates = enabledModelProtocols.flatMap((protocol) => {
    const offer = byProtocol.get(protocol);
    return offer ? [offer] : [];
  });

  for (const offer of candidates) {
    const supported = new Set(offer.supported);
    const missingRequired = requirement.required.filter((capability) => !supported.has(capability));
    if (missingRequired.length > 0) continue;
    const losses = requirement.preferred.filter((capability) => !supported.has(capability)).map((capability) => ({
      capability,
      disposition: "preferred-unavailable" as const,
      protocol: offer.protocol,
    }));
    return deepFreeze(CAPABILITY_NEGOTIATION_SCHEMA.parse({
      accepted: true,
      selectedProtocol: offer.protocol,
      losses,
    }));
  }

  const best = candidates.toSorted((left, right) => {
    const leftSet = new Set(left.supported);
    const rightSet = new Set(right.supported);
    return requirement.required.filter((capability) => !leftSet.has(capability)).length -
      requirement.required.filter((capability) => !rightSet.has(capability)).length;
  })[0];
  const supported = new Set(best?.supported ?? []);
  const losses = requirement.required.filter((capability) => !supported.has(capability)).map((capability) => ({
    capability,
    disposition: "required-unsupported" as const,
    ...(best ? { protocol: best.protocol } : {}),
  }));
  return deepFreeze(CAPABILITY_NEGOTIATION_SCHEMA.parse({
    accepted: false,
    selectedProtocol: null,
    losses: losses.slice(0, settings.limits.maximumLosses),
  }));
}

function assertUnique(values: readonly string[], code: string): void {
  if (new Set(values).size !== values.length) {
    throw new InputError("Capability declarations must not contain duplicates", code);
  }
}
