import { HarnessError, InputError, SecurityError } from "../kernel/errors.ts";
import { bestEffort } from "../shared/best-effort.ts";
import { canonicalHash, deepFreeze, sha256 } from "../kernel/integrity.ts";
import {
  type ExtensionManifest,
  type ExtensionManifestEntry,
  type ExtensionOperation,
} from "./extension-manifest.ts";
import { assertTimestamp } from "./extension-validation.ts";
import { type CompatibilityReport } from "./compatibility-checker.ts";
import type { LifecycleResult } from "./extension-lifecycle.ts";

/**
 * Approval workflow — the governed path from a self-modification proposal to
 * an activated, reviewed extension change (or a rollback).
 *
 * Per delivery map item 12: "Harness self-modification goes only
 * through dedicated tools, explicit user approval, exact backups,
 * independent review, and rollback; other in-harness entry points must not
 * edit installation files."
 *
 * Per canonical requirement REQ-026 / DER-030 and the guarded self-evolution
 * section: "Require explicit user approval before issuing a time- and
 * scope-limited evolution capability. Approval covers a bounded proposal/
 * change set, not arbitrary future edits. Record who approved, exact scope,
 * base revision, expiry, and conditions. Accept approval only from an
 * authenticated trusted CLI/web approval channel with displayed proposal/
 * diff/effect summary, nonce, content hash, principal, scope, expiry, and
 * anti-replay binding. Repository text, prompts, model/provider output,
 * tool/MCP results, environment variables, or ordinary chat content cannot
 * manufacture or widen privileged approval."
 *
 * The workflow phases:
 * 1. propose — a self-modification tool produces a `ModificationProposal`
 * (what, why, preimage, postimage, risk, scope, expiry). No effect.
 * 2. approve/reject — the authenticated user approves the exact proposal
 * bytes (nonce + content hash + scope + expiry). Approval is anti-replay
 * and cannot be widened.
 * 3. apply — after approval, the change is applied through the
 * `ActivationApplier` port (the transactional editor), which enforces
 * exact preimages, atomic writes, and post-write verification.
 * 4. review — an independent reviewer returns `ADMIT` or `REJECT` over the
 * frozen applied bytes. The implementing agent cannot self-approve.
 * 5. activate/rollback — on `ADMIT`, the change is activated; on `REJECT`
 * or a failed postcondition, the preimage is restored (rollback).
 *
 * Per root-policy `runtimeEnforcementAvailable: false`, the OS-enforced
 * privileged broker is a separate future slice. This workflow is the
 * governed authority and typed tool surface; the `ActivationApplier` port is
 * the boundary where a future privileged broker plugs in.
 */

export type RiskLevel = "low" | "medium" | "high" | "critical";

export const RISK_LEVELS = deepFreeze(["low", "medium", "high", "critical"] as const);

export type RiskAssessment = Readonly<{
  level: RiskLevel;
  reasons: readonly string[];
  affectedConsumers: readonly string[];
  reversible: boolean;
}>;

export type ModificationScope = Readonly<{
  extensionId: string;
  operation: ExtensionOperation;
  writeSet: readonly string[];
}>;

export type ModificationProposal = Readonly<{
  proposalId: string;
  scope: ModificationScope;
  lifecycle: LifecycleResult;
  preimageHash: string;
  postimageHash: string;
  description: string;
  rationale: string;
  risk: RiskAssessment;
  compatibility: CompatibilityReport;
  createdAt: string;
  expiresAt: string;
  contentHash: string;
  status: ProposalStatus;
}>;

export type ProposalStatus = "pending" | "approved" | "rejected" | "applied" | "reviewed" | "activated" | "rolled-back" | "expired";

export const PROPOSAL_STATUSES = deepFreeze([
  "pending",
  "approved",
  "rejected",
  "applied",
  "reviewed",
  "activated",
  "rolled-back",
  "expired",
] as const);

export type ApprovalPrincipal = Readonly<{
  kind: "user" | "cli" | "web";
  id: string;
}>;

export type ApprovalGrant = Readonly<{
  grantId: string;
  proposalId: string;
  proposalContentHash: string;
  nonce: string;
  principal: ApprovalPrincipal;
  scope: ModificationScope;
  issuedAt: string;
  expiresAt: string;
  baseRevision: string;
}>;

export type ReviewVerdict = "ADMIT" | "REJECT";

export type ReviewResult = Readonly<{
  reviewId: string;
  proposalId: string;
  verdict: ReviewVerdict;
  reviewer: ApprovalPrincipal;
  appliedContentHash: string;
  contractHash: string;
  findings: readonly string[];
  conditions: readonly string[];
  reviewedAt: string;
}>;

export type ActivationOutcome = Readonly<{
  proposalId: string;
  activated: boolean;
  activatedEntry: ExtensionManifestEntry | null;
  rolledBack: boolean;
  rollbackReason: string | null;
  appliedAt: string;
}>;

export type ActivationApplier = Readonly<{
  applyProposal(proposal: ModificationProposal): Readonly<{ success: boolean; postimageHash: string; reason?: string }>;
  rollbackProposal(proposal: ModificationProposal): Readonly<{ success: boolean; reason?: string }>;
}>;

export type ExtensionEffectRecorder = Readonly<{
  recordProposal(proposal: ModificationProposal): void;
  recordApproval(grant: ApprovalGrant): void;
  recordRejection(proposal: ModificationProposal, principal: ApprovalPrincipal, reason: string): void;
  recordApplication(proposal: ModificationProposal, postimageHash: string, success: boolean): void;
  recordReview(result: ReviewResult): void;
  recordActivation(outcome: ActivationOutcome): void;
  recordRollback(proposal: ModificationProposal, reason: string): void;
}>;

export type ApprovalWorkflowOptions = Readonly<{
  applier: ActivationApplier;
  recorder?: ExtensionEffectRecorder;
  clock?: () => string;
  idGenerator?: () => string;
  approvalTtlMs: number;
}>;

export class ApprovalError extends HarnessError {
  constructor(message: string, code = "approval_workflow_invalid") {
    super(message, code);
  }
}

const PROPOSAL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function defaultClock(): string {
  return new Date().toISOString();
}

let idCounter = 0;
function defaultId(): string {
  // UUID v4-format string generated without node:crypto so the module stays
  // a pure domain-layer dependency (no cryptography effect). Collision
  // resistance is not required here: the workflow accepts an injectable
  // idGenerator and clock for deterministic tests, and proposal/grant/review
  // identities are also bound by content hashes for integrity.
  idCounter = (idCounter + 1) % 0x100000000;
  const rand = (len: number): string => {
    let out = "";
    for (let i = 0; i < len; i++) out += Math.floor(Math.random() * 16).toString(16);
    return out;
  };
  const time = Date.now().toString(16).padStart(12, "0").slice(-12);
  const seq = idCounter.toString(16).padStart(4, "0").slice(-4);
  return `${rand(8)}-${time.slice(0, 4)}-4${rand(3)}-a${rand(3)}-${seq}${rand(8)}`;
}

function assertPrincipal(principal: ApprovalPrincipal): void {
  if (typeof principal !== "object" || principal === null) {
    throw new InputError("Approval principal must be an object", "approval_invalid_principal");
  }
  if (principal.kind !== "user" && principal.kind !== "cli" && principal.kind !== "web") {
    throw new InputError("Approval principal.kind must be user, cli, or web", "approval_invalid_principal");
  }
  if (typeof principal.id !== "string" || principal.id.length === 0) {
    throw new InputError("Approval principal.id must be a non-empty string", "approval_invalid_principal");
  }
}

function proposalContentHash(
  scope: ModificationScope,
  lifecycle: LifecycleResult,
  risk: RiskAssessment,
  preimageHash: string,
  postimageHash: string,
  expiresAt: string,
): string {
  return canonicalHash({
    scope,
    operation: lifecycle.operation,
    extensionId: lifecycle.extensionId,
    preimageHash,
    postimageHash,
    risk,
    expiresAt,
  });
}

export function assessRisk(
  operation: ExtensionOperation,
  compatibility: CompatibilityReport,
  dependents: readonly string[],
  reversible: boolean,
): RiskAssessment {
  const reasons: string[] = [];
  let level: RiskLevel = "low";
  if (operation === "delete" || operation === "downgrade") {
    level = "high";
    reasons.push(`${operation} is an inherently risky operation`);
  }
  if (operation === "upgrade") {
    level = level === "low" ? "medium" : level;
    reasons.push("upgrade changes the active version");
  }
  if (compatibility.blockingCount > 0) {
    level = "critical";
    reasons.push(`${compatibility.blockingCount} blocking compatibility finding(s)`);
  }
  if (dependents.length > 0) {
    if (level === "low") level = "medium";
    reasons.push(`${dependents.length} dependent extension(s) affected`);
  }
  if (!reversible) {
    if (level === "low") level = "medium";
    if (level === "medium") level = "high";
    reasons.push("operation is not reversible");
  }
  return deepFreeze({ level, reasons, affectedConsumers: [...dependents], reversible });
}

export type ProposeOptions = Readonly<{
  scope: ModificationScope;
  lifecycle: LifecycleResult;
  description: string;
  rationale: string;
  compatibility: CompatibilityReport;
  dependents?: readonly string[];
  reversible?: boolean;
  createdAt?: string;
  approvalTtlMs?: number;
}>;

export function buildProposal(options: ProposeOptions, workflow: ApprovalWorkflow): ModificationProposal {
  return workflow.propose(options);
}

export type ApprovalWorkflow = Readonly<{
  propose(options: ProposeOptions): ModificationProposal;
  approve(proposal: ModificationProposal, principal: ApprovalPrincipal, baseRevision: string): ApprovalGrant;
  reject(proposal: ModificationProposal, principal: ApprovalPrincipal, reason: string): void;
  apply(grant: ApprovalGrant, proposal: ModificationProposal): Readonly<{ success: boolean; postimageHash: string; reason?: string }>;
  review(grant: ApprovalGrant, proposal: ModificationProposal, verdict: ReviewVerdict, reviewer: ApprovalPrincipal, findings?: readonly string[], conditions?: readonly string[]): ReviewResult;
  activate(review: ReviewResult, grant: ApprovalGrant, proposal: ModificationProposal): ActivationOutcome;
  isExpired(proposal: ModificationProposal, now?: string): boolean;
  verifyGrant(grant: ApprovalGrant, proposal: ModificationProposal): boolean;
}>;

export function createApprovalWorkflow(options: ApprovalWorkflowOptions): ApprovalWorkflow {
  const applier = options.applier;
  const recorder = options.recorder;
  const clock = options.clock ?? defaultClock;
  const idGen = options.idGenerator ?? defaultId;
  const approvalTtlMs = options.approvalTtlMs;
  if (typeof approvalTtlMs !== "number" || !Number.isFinite(approvalTtlMs) || approvalTtlMs <= 0) {
    throw new InputError("approvalTtlMs must be a positive finite number", "approval_invalid_ttl");
  }

  function propose(input: ProposeOptions): ModificationProposal {
    const { scope, lifecycle, description, rationale, compatibility } = input;
    if (scope.extensionId !== lifecycle.extensionId) {
      throw new ApprovalError(
        `Scope extensionId '${scope.extensionId}' does not match lifecycle extensionId '${lifecycle.extensionId}'`,
        "approval_scope_mismatch",
      );
    }
    if (scope.operation !== lifecycle.operation) {
      throw new ApprovalError(
        `Scope operation '${scope.operation}' does not match lifecycle operation '${lifecycle.operation}'`,
        "approval_scope_mismatch",
      );
    }
    if (typeof description !== "string" || description.length === 0) {
      throw new InputError("Proposal description must be a non-empty string", "approval_invalid_description");
    }
    const createdAt = input.createdAt ?? clock();
    assertTimestamp(createdAt, "createdAt", "approval_invalid_timestamp");
    const ttl = input.approvalTtlMs ?? approvalTtlMs;
    const expiresAt = new Date(Date.parse(createdAt) + ttl).toISOString();
    const reversible = input.reversible ?? true;
    const dependents = input.dependents ?? [];
    const risk = assessRisk(scope.operation, compatibility, dependents, reversible);
    const contentHash = proposalContentHash(scope, lifecycle, risk, lifecycle.preimageHash, lifecycle.postimageHash, expiresAt);
    const proposalId = idGen();
    if (!PROPOSAL_ID_PATTERN.test(proposalId)) {
      throw new ApprovalError("Generated proposal id is not a valid UUID", "approval_invalid_proposal_id");
    }
    const proposal: ModificationProposal = deepFreeze({
      proposalId,
      scope,
      lifecycle,
      preimageHash: lifecycle.preimageHash,
      postimageHash: lifecycle.postimageHash,
      description,
      rationale,
      risk,
      compatibility,
      createdAt,
      expiresAt,
      contentHash,
      status: "pending",
    });
    if (recorder !== undefined) {
      bestEffort(() => recorder.recordProposal(proposal));
    }
    return proposal;
  }

  function isExpired(proposal: ModificationProposal, now?: string): boolean {
    const current = now ?? clock();
    return Date.parse(current) >= Date.parse(proposal.expiresAt);
  }

  function verifyGrant(grant: ApprovalGrant, proposal: ModificationProposal): boolean {
    if (grant.proposalId !== proposal.proposalId) return false;
    if (grant.proposalContentHash !== proposal.contentHash) return false;
    if (grant.scope.extensionId !== proposal.scope.extensionId) return false;
    if (grant.scope.operation !== proposal.scope.operation) return false;
    const now = clock();
    if (Date.parse(now) >= Date.parse(proposal.expiresAt)) return false;
    if (Date.parse(now) >= Date.parse(grant.expiresAt)) return false;
    return true;
  }

  function approve(proposal: ModificationProposal, principal: ApprovalPrincipal, baseRevision: string): ApprovalGrant {
    assertPrincipal(principal);
    if (typeof baseRevision !== "string" || baseRevision.length === 0) {
      throw new InputError("baseRevision must be a non-empty string", "approval_invalid_base_revision");
    }
    if (isExpired(proposal)) {
      throw new ApprovalError(
        `Proposal '${proposal.proposalId}' has expired`,
        "approval_proposal_expired",
      );
    }
    const grantId = idGen();
    const nonce = idGen();
    const issuedAt = clock();
    assertTimestamp(issuedAt, "issuedAt", "approval_invalid_timestamp");
    const grant: ApprovalGrant = deepFreeze({
      grantId,
      proposalId: proposal.proposalId,
      proposalContentHash: proposal.contentHash,
      nonce,
      principal,
      scope: proposal.scope,
      issuedAt,
      expiresAt: proposal.expiresAt,
      baseRevision,
    });
    if (recorder !== undefined) {
      bestEffort(() => recorder.recordApproval(grant));
    }
    return grant;
  }

  function reject(proposal: ModificationProposal, principal: ApprovalPrincipal, reason: string): void {
    assertPrincipal(principal);
    if (typeof reason !== "string" || reason.length === 0) {
      throw new InputError("Rejection reason must be a non-empty string", "approval_invalid_rejection_reason");
    }
    if (recorder !== undefined) {
      bestEffort(() => recorder.recordRejection(proposal, principal, reason));
    }
  }

  function apply(grant: ApprovalGrant, proposal: ModificationProposal): Readonly<{ success: boolean; postimageHash: string; reason?: string }> {
    if (!verifyGrant(grant, proposal)) {
      throw new SecurityError(
        `Approval grant '${grant.grantId}' does not verify against proposal '${proposal.proposalId}'`,
        "approval_grant_invalid",
      );
    }
    const result = applier.applyProposal(proposal);
    if (recorder !== undefined) {
      bestEffort(() => recorder.recordApplication(proposal, result.postimageHash, result.success));
    }
    return result;
  }

  function review(
    grant: ApprovalGrant,
    proposal: ModificationProposal,
    verdict: ReviewVerdict,
    reviewer: ApprovalPrincipal,
    findings?: readonly string[],
    conditions?: readonly string[],
  ): ReviewResult {
    assertPrincipal(reviewer);
    if (reviewer.id === grant.principal.id) {
      throw new SecurityError(
        "Reviewer cannot be the same principal who approved the proposal",
        "approval_reviewer_is_approver",
      );
    }
    if (verdict !== "ADMIT" && verdict !== "REJECT") {
      throw new InputError("Review verdict must be ADMIT or REJECT", "approval_invalid_verdict");
    }
    const reviewId = idGen();
    const reviewedAt = clock();
    assertTimestamp(reviewedAt, "reviewedAt", "approval_invalid_timestamp");
    const contractHash = canonicalHash({
      proposalId: proposal.proposalId,
      proposalContentHash: proposal.contentHash,
      appliedHash: proposal.postimageHash,
      verdict,
      reviewer: reviewer.id,
      findings: findings ?? [],
      conditions: conditions ?? [],
    });
    const result: ReviewResult = deepFreeze({
      reviewId,
      proposalId: proposal.proposalId,
      verdict,
      reviewer,
      appliedContentHash: proposal.postimageHash,
      contractHash,
      findings: findings ?? [],
      conditions: conditions ?? [],
      reviewedAt,
    });
    if (recorder !== undefined) {
      bestEffort(() => recorder.recordReview(result));
    }
    return result;
  }

  function activate(review: ReviewResult, grant: ApprovalGrant, proposal: ModificationProposal): ActivationOutcome {
    if (review.proposalId !== proposal.proposalId) {
      throw new ApprovalError("Review does not match proposal", "approval_review_mismatch");
    }
    if (!verifyGrant(grant, proposal)) {
      throw new SecurityError("Grant does not verify during activation", "approval_grant_invalid");
    }
    const appliedAt = clock();
    assertTimestamp(appliedAt, "appliedAt", "approval_invalid_timestamp");
    if (review.verdict === "ADMIT") {
      const outcome: ActivationOutcome = deepFreeze({
        proposalId: proposal.proposalId,
        activated: true,
        activatedEntry: proposal.lifecycle.nextEntry,
        rolledBack: false,
        rollbackReason: null,
        appliedAt,
      });
      if (recorder !== undefined) {
        bestEffort(() => recorder.recordActivation(outcome));
      }
      return outcome;
    }
    const rollbackResult = applier.rollbackProposal(proposal);
    const outcome: ActivationOutcome = deepFreeze({
      proposalId: proposal.proposalId,
      activated: false,
      activatedEntry: null,
      rolledBack: rollbackResult.success,
      rollbackReason: review.findings[0] ?? "review rejected",
      appliedAt,
    });
    if (recorder !== undefined) {
      bestEffort(() => recorder.recordRollback(proposal, outcome.rollbackReason ?? "review rejected"));
    }
    return outcome;
  }

  return deepFreeze({ propose, approve, reject, apply, review, activate, isExpired, verifyGrant });
}

export type ApprovalStateStore = Readonly<{
  recordGrant(grant: ApprovalGrant): void;
  consumeGrant(grantId: string, proposalContentHash: string): ApprovalGrant | undefined;
  recordProposal(proposal: ModificationProposal): void;
  getProposal(proposalId: string): ModificationProposal | undefined;
}>;

/**
 * In-memory anti-replay store. Production deployments back this with durable
 * storage so a consumed nonce cannot be reused across process restarts.
 */
export function createMemoryApprovalStateStore(): ApprovalStateStore {
  const grants = new Map<string, ApprovalGrant>();
  const proposals = new Map<string, ModificationProposal>();
  const consumed = new Set<string>();
  return deepFreeze({
    recordGrant(grant: ApprovalGrant): void {
      if (consumed.has(grant.nonce)) {
        throw new SecurityError(`Approval nonce '${grant.nonce}' has already been consumed`, "approval_nonce_replay");
      }
      grants.set(grant.grantId, grant);
      proposals.set(grant.proposalId, deepFreeze({ ...grant } as unknown as ModificationProposal));
    },
    consumeGrant(grantId: string, proposalContentHash: string): ApprovalGrant | undefined {
      const grant = grants.get(grantId);
      if (grant === undefined) return undefined;
      if (grant.proposalContentHash !== proposalContentHash) return undefined;
      if (consumed.has(grant.nonce)) return undefined;
      consumed.add(grant.nonce);
      return grant;
    },
    recordProposal(proposal: ModificationProposal): void {
      proposals.set(proposal.proposalId, proposal);
    },
    getProposal(proposalId: string): ModificationProposal | undefined {
      return proposals.get(proposalId);
    },
  });
}

export { sha256 };
export type { ExtensionManifest };
