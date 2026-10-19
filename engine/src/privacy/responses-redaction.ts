/** Semantic redaction of a complete Responses body, before its sole mint. */
import { heldValues, type HeldSet } from "./held-set.ts";
import { SecurityError } from "../kernel/errors.ts";
import { snapshotJsonValue, type StructuralSnapshotLimits } from "../kernel/safe-structural.ts";
import { urlCredentialSpellings } from "./secret-parts.ts";
import { mapStringValues, type StringValueLocation } from "../shared/string-values.ts";
import { isPlainObject } from "../shared/type-guards.ts";
import { knownSecretSpans } from "./secret-intelligence.ts";
import { redactMessagesTogether, detectProtocolIdentitySensitiveSpans, type ExplainedSpan, type DetectionOptions, type RedactionExplanation } from "./redaction-engine.ts";
import { redactionReplacement, type PrivacyPolicy } from "./privacy-policy.ts";
type Slot = "text" | "identity" | "credential" | "url" | "opaque";
export function assertResponseIdentity(text: string, detect: (value: string) => readonly ExplainedSpan[] = detectProtocolIdentitySensitiveSpans): void {
  if (knownSecretSpans(text).length || detect(text).length) throw new SecurityError("A protocol identity collides with sensitive text", "responses_identity_sensitive");
}
function slotAt({ path, ancestors }: StringValueLocation): Slot {
  const key = path.at(-1), parent = ancestors.at(-1);
  if (path.length === 1 && ["model", "previous_response_id", "conversation"].includes(String(key))) return "identity";
  if (path[0] === "conversation" && path.length === 2 && key === "id") return "identity";
  if (path[0] === "prompt" && path.length === 2 && ["id", "version"].includes(String(key))) return "identity";
  if (path[0] === "tools" && typeof path[1] === "number") {
    const tool = ancestors[2];
    if (path.length === 3 && ["type", "name", "server_label"].includes(String(key))) return "identity";
    if (path[2] === "parameters" && (["const", "type"].includes(String(key)) || ["enum", "required"].includes(String(path.at(-2))))) return "identity";
    if (isPlainObject(tool) && tool.type === "mcp" && (path.length === 3 && key === "authorization" || path.length === 4 && path[2] === "headers")) return "credential";
    // Intentional container network credentials are exact native transport slots.
    if (isPlainObject(tool) && ((tool.type === "code_interpreter" && path[2] === "container") ||
        (tool.type === "shell" && path[2] === "environment")) && path.length === 7 &&
        path[3] === "network_policy" && path[4] === "domain_secrets" && typeof path[5] === "number" && key === "value" &&
        isPlainObject(ancestors[3]) && ancestors[3].type === (tool.type === "shell" ? "container_auto" : "auto") &&
        isPlainObject(ancestors[4]) && ancestors[4].type === "allowlist") return "credential";
    if (isPlainObject(tool) && tool.type === "image_generation" && path.length === 4 && path[2] === "input_image_mask" && key === "image_url") return "url";
  }
  const item = path[0] === "input" && typeof path[1] === "number";
  const rootItem = item && isPlainObject(ancestors[2]) ? ancestors[2] : undefined;
  const rootField = item && path.length === 3;
  const messagePart = rootItem && (rootItem.type === "message" || rootItem.type === undefined && typeof rootItem.role === "string") && path[2] === "content";
  const agentPart = rootItem?.type === "agent_message" && path[2] === "content";
  const callOutputPart = rootItem && ["function_call_output", "custom_tool_call_output"].includes(String(rootItem.type)) && path[2] === "output";
  const arrayPart = item && path.length === 5 && typeof path[3] === "number" && (messagePart || callOutputPart || agentPart);
  const promptPart = path[0] === "prompt" && path[1] === "variables" && path.length === 4;
  if (isPlainObject(parent)) {
    if (arrayPart && agentPart && parent.type === "encrypted_content" && key === "encrypted_content") return "opaque";
    if (rootField && ["reasoning", "compaction"].includes(String(parent.type)) && key === "encrypted_content") return "opaque";
    if (rootField && parent.type === "program" && key === "fingerprint") return "opaque";
    if (rootField && parent.type === "image_generation_call" && key === "result") return "opaque";
    if (rootField && ["id", "call_id", "approval_request_id", "file_id", "container_id", "type", "role", "status", "name", "namespace"].includes(String(key))) return "identity";
    if ((arrayPart || promptPart) && (parent.type === "input_image" && key === "image_url" || parent.type === "input_file" && key === "file_url")) return "url";
    if ((arrayPart || promptPart) && parent.type === "input_file" && key === "file_data") return "opaque";
    if ((arrayPart || promptPart) && ["input_file", "input_image"].includes(String(parent.type)) && key === "file_id") return "identity";
    if (item && path.length === 4 && path[2] === "caller" && parent.type === "program" && key === "caller_id" &&
        ["function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output", "shell_call", "shell_call_output", "apply_patch_call", "apply_patch_call_output"].includes(String(rootItem?.type))) return "identity";
    if (item && rootItem?.type === "computer_call_output" && path.length === 4 && path[2] === "output" && parent.type === "computer_screenshot") {
      if (key === "image_url") return "url";
      if (key === "file_id") return "identity";
    }
  }
  if (item && messagePart && path.length === 6 && path[4] === "input_audio" && key === "data") return "opaque";
  return "text";
}
export function isResponseObservationResource(value: unknown): boolean {
  return isPlainObject(value) && ["response", "response.compaction", "response.input_tokens", "list"].includes(String(value.object));
}
/** Normalize only trusted envelope mode and genuine native event wrappers. */
export function responseObservationLocation(location: StringValueLocation, envelope = false): StringValueLocation {
  let { path, ancestors } = location;
  if (envelope) {
    const offset = path[0] === "response" ? 1 : path[0] === "evidence" && typeof path[1] === "number" ? 2 : 0;
    if (!offset) return location;
    path = path.slice(offset); ancestors = ancestors.slice(offset);
  }
  const root = ancestors[0];
  if (isPlainObject(root) && !isResponseObservationResource(root) &&
      typeof root.type === "string" && root.type.startsWith("response.") && path[0] === "response") {
    path = path.slice(1); ancestors = ancestors.slice(1);
  }
  return { path, ancestors };
}
/** Reuse request replay slots for native resources and their documented event wrappers. */
export function responseObservationSlot(location: StringValueLocation): Slot {
  let { path, ancestors } = responseObservationLocation(location);
  const root = ancestors[0];
  if (isPlainObject(root) && !isResponseObservationResource(root) && typeof root.type === "string" && root.type.startsWith("response.")) {
    // Partial text is not independently redactable: a credential can span frames.
    if (root.type.endsWith(".delta") && path.length === 1 && ["delta", "arguments", "input"].includes(String(path[0]))) return "opaque";
    if (path.length === 1 && ["partial_image_b64", "obfuscation"].includes(String(path[0]))) return "opaque";
    if (["response.output_item.added", "response.output_item.done"].includes(root.type) && path[0] === "item") {
      path = ["input", 0, ...path.slice(1)]; ancestors = [{ input: [root.item] }, [root.item], ...ancestors.slice(1)];
    }
  }
  const resource = ancestors[0];
  if (isPlainObject(resource) && ["response", "response.compaction"].includes(String(resource.object)) && path[0] === "output") path = ["input", ...path.slice(1)];
  if (isPlainObject(resource) && resource.object === "list" && Array.isArray(resource.data) && path[0] === "data") path = ["input", ...path.slice(1)];
  return slotAt({ path, ancestors });
}
function registerUrlSecrets(text: string, policy: PrivacyPolicy): readonly string[] {
  // A data: URL is inline content, not a locator: it carries no credentials.
  // Every other URL's credentials come from the secret-parts owner, in every
  // spelling a text carries them (a2-correctness §2), decoded at most
  // `policy.urlDecodeLevels` times (a2b-correctness H-1) — and only for this
  // call (the minted request's held list), never in the process-wide
  // registry: a value from one user's request used to mask every other
  // user's text and, 64 of them, to switch registration off (CRED-F2/F3).
  return text.startsWith("data:") ? [] : urlCredentialSpellings(text, policy.urlDecodeLevels);
}
/** Opaque media/ciphertext transport exactly; this does not inspect them. */
export function redactResponsesBody(value: unknown, policy: PrivacyPolicy, options: DetectionOptions, limits: StructuralSnapshotLimits, context?: unknown): Readonly<{ request: unknown; observation: unknown; heldCredentials: HeldSet; redactions: readonly RedactionExplanation[] }> {
  const keys: string[] = [], credentials: string[] = [];
  const collectCredentials = (source: unknown, sourceKeys: string[]) => mapStringValues(source, (text, location) => {
    const slot = slotAt(location);
    if (slot === "credential") credentials.push(text);
    if (slot === "url") credentials.push(...registerUrlSecrets(text, policy));
    return text;
  }, key => { sourceKeys.push(key); });
  collectCredentials(value, keys);
  const texts: string[] = [], argumentsByPath = new Map<string, unknown>();
  const collectText = (source: unknown, sourceTexts: string[], sourceKeys: string[], argumentsMap?: Map<string, unknown>) => mapStringValues(source, (text, location) => {
    if (slotAt(location) !== "text") return text;
    sourceTexts.push(text);
    if (location.path.at(-1) === "arguments") {
      try {
        const parsed = snapshotJsonValue(JSON.parse(text), limits, "responses_arguments_structure_invalid");
        argumentsMap?.set(JSON.stringify(location.path), parsed);
        mapStringValues(parsed, child => { sourceTexts.push(child); return child; }, key => { sourceKeys.push(key); });
      } catch (error) { if (error instanceof SyntaxError) { /* Partial/custom arguments remain text. */ } else throw error; }
    }
    return text;
  });
  collectText(value, texts, keys, argumentsByPath);
  const contextTexts: string[] = [], contextKeys: string[] = [];
  if (context !== undefined) {
    collectCredentials(context, contextKeys);
    collectText(context, contextTexts, contextKeys);
  }
  // The request's credentials HELD with the policy's floor (the held-set
  // owner applies it to every value it merges): a shorter one is replaced in
  // its own slot, exactly (`credentials` keeps it), but matched nowhere else
  // in text. A key or identity EQUAL to any credential is still refused (an
  // exact test, which shreds nothing, and keeps the value out of the labels
  // the observation shows).
  const heldCredentials = heldValues("request:credential", credentials, policy.heldCredentialMinimumLength).merge(options.heldCredentials);
  const turn = redactMessagesTogether([...texts, ...keys, ...contextTexts, ...contextKeys], policy, { ...options, heldCredentials });
  if (keys.some(key => credentials.includes(key) || knownSecretSpans(key).length || turn.redact(key) !== key)) throw new SecurityError("A JSON key collides with sensitive text", "responses_identity_sensitive");
  let index = 0;
  const redactions: RedactionExplanation[] = [];
  const projectText = (text: string) => {
    const at = index++, safe = turn.redacted[at]!;
    return { text: credentials.includes(text) ? redactionReplacement("token", policy) : safe, explanations: turn.explanations[at]! };
  };
  const request = mapStringValues(value, (text, location) => {
    if (slotAt(location) === "identity") {
      if (credentials.includes(text)) throw new SecurityError("A protocol identity collides with sensitive text", "responses_identity_sensitive");
      assertResponseIdentity(text, turn.detectProtocolIdentity);
      return text;
    }
    if (slotAt(location) !== "text") return text;
    const projected = projectText(text), path = JSON.stringify(location.path);
    if (!argumentsByPath.has(path)) { if (projected.text !== text) redactions.push(...projected.explanations); return projected.text; }
    let changed = false;
    const children: RedactionExplanation[] = [];
    const parsed = mapStringValues(argumentsByPath.get(path), original => { const safe = projectText(original); changed ||= safe.text !== original;
      if (safe.text !== original) children.push(...safe.explanations); return safe.text; });
    if (changed) { redactions.push(...children); return JSON.stringify(parsed); }
    if (projected.text !== text) redactions.push(...projected.explanations);
    return projected.text;
  });
  return { request, redactions, observation: observeResponsesBody(request, policy, turn.redact), heldCredentials };
}
/** Observation is separate: intentional protocol secrets never leave it. */
function observeResponsesBody(value: unknown, policy: PrivacyPolicy, redact?: (text: string) => string): unknown {
  return mapStringValues(value, (text, location) => {
    const slot = slotAt(location);
    if (slot === "credential" || slot === "opaque") return redactionReplacement("token", policy);
    if (slot === "url") {
      // Media references are credentials anywhere in the locator, including encoded path segments.
      // Expose only the origin, under the SAME turn detector. Already-redacted callers without
      // that context get an opaque marker; declarations cannot be reconstructed afterward.
      if (!redact || text.startsWith("data:")) return redactionReplacement("token", policy);
      try { return redact(new URL(text).origin); }
      catch { return redactionReplacement("token", policy); }
    }
    return text;
  });
}
