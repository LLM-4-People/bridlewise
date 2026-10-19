/** Sole provider-body mint: immutable native requests, operation-bound admission. */
import { InputError, SecurityError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import { snapshotJsonValue } from "../kernel/safe-structural.ts";
import { resolveResponsesTransportConfig, type ResponsesTransportConfig, type ResponsesTransportConfigInput } from "../shared/llm/config.ts";
import { RESPONSE_REQUEST_SCHEMAS, RESPONSE_INPUT_TOKENS_REQUEST_SCHEMA,
  type ResponseOperation, type ResponseRequestFor } from "../shared/llm/responses-endpoints.ts";
import { DEFAULT_PRIVACY_POLICY, type PrivacyPolicy } from "./privacy-policy.ts";
import type { DetectionOptions, RedactionExplanation } from "./redaction-engine.ts";
import { redactResponsesBody } from "./responses-redaction.ts";
import type { HeldSet } from "./held-set.ts";

const BRAND: unique symbol = Symbol("redacted-responses-request");
export type MintedRequestContext = RequestRedactionOptions & { heldCredentials: HeldSet };
const MINTED = new WeakMap<object, Readonly<{ limits: ResponsesTransportConfig; observation: unknown; redactions: readonly RedactionExplanation[]; context: MintedRequestContext }>>();
export interface RedactedResponsesRequest<Operation extends ResponseOperation = ResponseOperation> {
  readonly [BRAND]: true;
  readonly operation: Operation;
  readonly request: ResponseRequestFor<Operation>;
}
export class ForgedRedactedRequestError extends SecurityError {
  constructor() { super("Provider request was not minted for this operation by the privacy boundary", "redacted_request_not_minted"); }
}
export function admitMintedRequest<Operation extends ResponseOperation>(value: RedactedResponsesRequest<Operation>, operation: Operation): ResponseRequestFor<Operation> {
  if (typeof value !== "object" || value === null || !MINTED.has(value) || value.operation !== operation) throw new ForgedRedactedRequestError();
  return value.request;
}
export function validateResponseRequest<Operation extends ResponseOperation>(operation: Operation, request: unknown, limits: ResponsesTransportConfigInput): ResponseRequestFor<Operation> {
  const resolved = resolveResponsesTransportConfig(limits);
  const snapshot = snapshotJsonValue(request, structuralLimits(resolved), "responses_request_structure_invalid");
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > resolved.maximumRequestBytes) throw new InputError("Responses request exceeds its byte bound", "responses_request_too_large");
  const parsed = RESPONSE_REQUEST_SCHEMAS[operation].safeParse(snapshot);
  if (!parsed.success) throw new InputError("Responses request does not match its operation schema", "responses_request_invalid");
  return deepFreeze(parsed.data) as ResponseRequestFor<Operation>;
}
/** `limits` is REQUIRED: the configured `runtime.responses` transport, never a code fallback (a2-design M5). */
export type RequestRedactionOptions = Readonly<{ policy?: PrivacyPolicy; detection?: DetectionOptions; /** Private native request fragment omitted by a host transform; never transmitted. */ context?: unknown; limits: ResponsesTransportConfigInput }>;
export function redactAndMintRequest<Operation extends ResponseOperation>(operation: Operation, request: unknown, options: RequestRedactionOptions): RedactedResponsesRequest<Operation> {
  const limits = deepFreeze(resolveResponsesTransportConfig(options.limits));
  const admitted = snapshotRequestContext(request, options.context, limits);
  const safe = validateResponseRequest(operation, admitted.request, limits);
  const { request: redacted, observation, heldCredentials, redactions } = redactResponsesBody(safe, options.policy ?? DEFAULT_PRIVACY_POLICY, options.detection ?? {}, structuralLimits(limits), admitted.context);
  snapshotRequestContext(redacted, admitted.context, limits, heldCredentials);
  return mint(operation, validateResponseRequest(operation, redacted, limits), limits, observation, { ...options, ...(admitted.context === undefined ? {} : { context: admitted.context }), limits, heldCredentials }, redactions);
}
function mint<Operation extends ResponseOperation>(operation: Operation, request: ResponseRequestFor<Operation>, limits: ResponsesTransportConfig, observation: unknown, context: MintedRequestContext, redactions: readonly RedactionExplanation[]): RedactedResponsesRequest<Operation> {
  const minted = deepFreeze({ [BRAND]: true as const, operation, request }) as RedactedResponsesRequest<Operation>;
  MINTED.set(minted, { limits, observation: deepFreeze(observation), redactions: deepFreeze(redactions), context: Object.freeze(context) });
  return minted;
}
export function observeMintedRequest<Operation extends ResponseOperation>(minted: RedactedResponsesRequest<Operation>): ResponseRequestFor<Operation> {
  admitMintedRequest(minted, minted.operation);
  return MINTED.get(minted)!.observation as ResponseRequestFor<Operation>;
}
export function projectRequestForInputTokens(minted: RedactedResponsesRequest<"create">): RedactedResponsesRequest<"input_tokens"> {
  const request = admitMintedRequest(minted, "create");
  const fields = new Set(Object.keys(RESPONSE_INPUT_TOKENS_REQUEST_SCHEMA.shape));
  const project = (value: object) => Object.fromEntries(Object.entries(value).filter(([key]) => fields.has(key)));
  const limits = MINTED.get(minted)!.limits;
  return mint("input_tokens", validateResponseRequest("input_tokens", project(request), limits), limits, project(observeMintedRequest(minted)), MINTED.get(minted)!.context, MINTED.get(minted)!.redactions);
}

/** Private operation context; never publish credentials with an observation. */
export function mintedRequestContext(minted: RedactedResponsesRequest): MintedRequestContext {
  admitMintedRequest(minted, minted.operation);
  return MINTED.get(minted)!.context;
}

function structuralLimits(limits: ResponsesTransportConfigInput) {
  const { maximumDepth, maximumNodes } = resolveResponsesTransportConfig(limits);
  return { maximumDepth, maximumNodes };
}

/** Same admitted snapshot and aggregate bound for transmitted body plus hidden detector context. */
export function snapshotRequestContext(request: unknown, context: unknown, options: ResponsesTransportConfigInput, heldCredentials?: HeldSet): Readonly<{request: unknown; context?: unknown}> {
  const limits = resolveResponsesTransportConfig(options);
  const snapshot = snapshotJsonValue({...(request === undefined ? {} : {request}), ...(context === undefined ? {} : {context}), ...(heldCredentials?.size ? {heldCredentials: heldCredentials.values()} : {})},
    {maximumDepth: limits.maximumDepth + 1, maximumNodes: limits.maximumNodes + 1}, "responses_request_structure_invalid") as {request: unknown; context?: unknown};
  const bytes = (snapshot.request === undefined ? 0 : Buffer.byteLength(JSON.stringify(snapshot.request), "utf8")) + (snapshot.context === undefined ? 0 : Buffer.byteLength(JSON.stringify(snapshot.context), "utf8")) + (heldCredentials?.size ? Buffer.byteLength(JSON.stringify(heldCredentials.values()), "utf8") : 0);
  if (bytes > limits.maximumRequestBytes) throw new InputError("Responses request exceeds its byte bound", "responses_request_too_large");
  if (snapshot.context !== undefined && !RESPONSE_REQUEST_SCHEMAS.create.safeParse(snapshot.context).success) {
    throw new InputError("Responses context must be a native request fragment", "responses_context_invalid");
  }
  return deepFreeze(snapshot);
}
/** Qualified explanations of transmitted text only, produced during the sole mint pass. */
export function mintedRequestRedactions(minted: RedactedResponsesRequest): readonly RedactionExplanation[] {
  admitMintedRequest(minted, minted.operation);
  return MINTED.get(minted)!.redactions;
}
