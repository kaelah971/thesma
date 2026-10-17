import type { CampaignState } from "../domain/enums";
import {
  analyzePolicyFields,
  assertS1Transition,
  isPolicySatisfied,
  type CampaignFieldOverrides,
  type CampaignPolicyFields,
  type PolicyVersionStatus,
} from "../domain/campaign";
import { newId } from "../auth/session";
import type { Interpretation } from "./intent";
import { LocalIntentInterpreter } from "./intent";
import type { AuditSink, CampaignStore } from "./campaignStore";

export interface CampaignDeps {
  store: CampaignStore;
  audit: AuditSink;
  interpreter?: { interpret(input: { text: string }): Promise<Interpretation> };
  /** Injectable clock for deterministic deadline tests. Defaults to wall time. */
  now?: () => Date;
}

function fail(status: number, code: string, message: string, details?: unknown): never {
  throw Object.assign(new Error(message), { status, code, details });
}

function wireToFields(o: CampaignFieldOverrides): Partial<CampaignPolicyFields> {
  return {
    ...(o.targetOutcomeCount !== undefined ? { targetOutcomeCount: o.targetOutcomeCount } : {}),
    ...(o.budgetMicroUsdc !== undefined ? { budgetMicroUsdc: BigInt(o.budgetMicroUsdc) } : {}),
    ...(o.bountyFloorMicroUsdc !== undefined ? { bountyFloorMicroUsdc: BigInt(o.bountyFloorMicroUsdc) } : {}),
    ...(o.bountyCeilingMicroUsdc !== undefined ? { bountyCeilingMicroUsdc: BigInt(o.bountyCeilingMicroUsdc) } : {}),
    ...(o.minQualifyingPurchaseMicroUsdc !== undefined
      ? { minQualifyingPurchaseMicroUsdc: BigInt(o.minQualifyingPurchaseMicroUsdc) }
      : {}),
    ...(o.deadline !== undefined ? { deadline: new Date(o.deadline) } : {}),
    ...(o.marketVisibility !== undefined ? { marketVisibility: o.marketVisibility } : {}),
    ...(o.allowedPartnerRulesJson !== undefined ? { allowedPartnerRulesJson: o.allowedPartnerRulesJson } : {}),
    ...(o.refundHoldSeconds !== undefined ? { refundHoldSeconds: o.refundHoldSeconds } : {}),
    ...(o.escalationRulesJson !== undefined ? { escalationRulesJson: o.escalationRulesJson } : {}),
  };
}

function emptyFields(): CampaignPolicyFields {
  return {
    targetOutcomeCount: null,
    budgetMicroUsdc: null,
    bountyFloorMicroUsdc: null,
    bountyCeilingMicroUsdc: null,
    minQualifyingPurchaseMicroUsdc: null,
    deadline: null,
    marketVisibility: "PUBLIC",
    allowedPartnerRulesJson: {},
    refundHoldSeconds: 0,
    escalationRulesJson: {},
  };
}

async function memberOrFail(deps: CampaignDeps, workspaceId: string, userId: string) {
  const m = await deps.store.getMembership(workspaceId, userId);
  if (!m) fail(403, "FORBIDDEN", "Not a workspace member");
  return m;
}

async function campaignInScope(deps: CampaignDeps, campaignId: string, userId: string) {
  const campaign = await deps.store.getCampaign(campaignId);
  if (!campaign) fail(404, "NOT_FOUND", "Campaign not found");
  await memberOrFail(deps, campaign.workspaceId, userId);
  const version = await deps.store.getCurrentVersion(campaignId);
  if (!version) fail(500, "INTERNAL", "Campaign has no policy version");
  return { campaign, version };
}

function toFields(v: CampaignPolicyFields): CampaignPolicyFields {
  return {
    targetOutcomeCount: v.targetOutcomeCount,
    budgetMicroUsdc: v.budgetMicroUsdc,
    bountyFloorMicroUsdc: v.bountyFloorMicroUsdc,
    bountyCeilingMicroUsdc: v.bountyCeilingMicroUsdc,
    minQualifyingPurchaseMicroUsdc: v.minQualifyingPurchaseMicroUsdc,
    deadline: v.deadline,
    marketVisibility: v.marketVisibility,
    allowedPartnerRulesJson: v.allowedPartnerRulesJson,
    refundHoldSeconds: v.refundHoldSeconds,
    escalationRulesJson: v.escalationRulesJson,
  };
}

/** Owner describes an objective; interpreter prepares a DRAFT. No money moves. */
export async function createDraft(
  deps: CampaignDeps,
  params: { workspaceId: string; userId: string; intentText: string; overrides?: CampaignFieldOverrides },
) {
  await memberOrFail(deps, params.workspaceId, params.userId);
  const interpreter = deps.interpreter ?? new LocalIntentInterpreter();
  const { fields, missing, notes } = await interpreter.interpret({ text: params.intentText });

  const merged: CampaignPolicyFields = {
    ...emptyFields(),
    ...(fields.targetOutcomeCount !== undefined ? { targetOutcomeCount: fields.targetOutcomeCount } : {}),
    ...(fields.budgetMicroUsdc !== undefined ? { budgetMicroUsdc: BigInt(fields.budgetMicroUsdc) } : {}),
    ...(fields.bountyFloorMicroUsdc !== undefined ? { bountyFloorMicroUsdc: BigInt(fields.bountyFloorMicroUsdc) } : {}),
    ...(fields.bountyCeilingMicroUsdc !== undefined ? { bountyCeilingMicroUsdc: BigInt(fields.bountyCeilingMicroUsdc) } : {}),
    ...(fields.minQualifyingPurchaseMicroUsdc !== undefined
      ? { minQualifyingPurchaseMicroUsdc: BigInt(fields.minQualifyingPurchaseMicroUsdc) }
      : {}),
    ...(fields.deadline !== undefined ? { deadline: new Date(fields.deadline) } : {}),
    ...wireToFields(params.overrides ?? {}),
  };

  const campaignId = newId();
  const versionId = newId();
  await deps.store.insertCampaign({
    id: campaignId,
    workspaceId: params.workspaceId,
    state: "DRAFT",
    createdByUserId: params.userId,
  });
  const version = await deps.store.insertVersion({
    id: versionId,
    campaignId,
    version: 1,
    intentText: params.intentText,
    status: "DRAFT",
    ...toFields(merged),
  });
  await deps.store.updateCampaign(campaignId, { currentPolicyVersionId: versionId });
  const campaign = (await deps.store.getCampaign(campaignId))!;

  await deps.audit({
    actorType: "USER",
    actorId: params.userId,
    workspaceId: params.workspaceId,
    action: "campaign.created",
    targetType: "campaign",
    targetId: campaignId,
    metadata: { campaignId, policyVersionId: versionId, version: 1, missing },
  });
  return { campaign, version, missing, notes };
}

/**
 * Revise the current draft. Non-approved versions are edited in place and
 * return to DRAFT; revising an APPROVED policy creates a NEW version and
 * reopens the campaign at DRAFT — approved rows are never mutated.
 */
export async function reviseDraft(
  deps: CampaignDeps,
  params: { campaignId: string; userId: string; expectedVersion: number; patch: CampaignFieldOverrides },
) {
  const { campaign, version } = await campaignInScope(deps, params.campaignId, params.userId);
  if (version.version !== params.expectedVersion) {
    fail(409, "CONFLICT", "Stale policy version", { expected: params.expectedVersion, current: version.version });
  }
  const patch = wireToFields(params.patch);

  if (version.status === "APPROVED") {
    assertS1Transition(campaign.state, "DRAFT");
    const nextId = newId();
    const next = await deps.store.insertVersion({
      id: nextId,
      campaignId: campaign.id,
      version: version.version + 1,
      intentText: version.intentText,
      status: "DRAFT",
      ...toFields({ ...toFields(version), ...patch }),
    });
    const updated = await deps.store.updateCampaign(campaign.id, { state: "DRAFT", currentPolicyVersionId: nextId });
    await deps.audit({
      actorType: "USER",
      actorId: params.userId,
      workspaceId: campaign.workspaceId,
      action: "campaign.policy_revision_created",
      targetType: "campaign",
      targetId: campaign.id,
      metadata: { campaignId: campaign.id, policyVersionId: nextId, version: next.version, supersedesVersion: version.version },
    });
    return { campaign: updated, version: next, createdNewVersion: true };
  }

  const merged = toFields({ ...toFields(version), ...patch });
  const nextStatus: PolicyVersionStatus = "DRAFT"; // revision always re-enters DRAFT
  const updatedVersion = await deps.store.updateVersion(campaign.id, version.version, { ...merged, status: nextStatus });
  const updated = await deps.store.updateCampaign(campaign.id, { state: "DRAFT" });
  await deps.audit({
    actorType: "USER",
    actorId: params.userId,
    workspaceId: campaign.workspaceId,
    action: "campaign.draft_revised",
    targetType: "campaign",
    targetId: campaign.id,
    metadata: { campaignId: campaign.id, policyVersionId: version.id, version: version.version },
  });
  return { campaign: updated, version: updatedVersion, createdNewVersion: false };
}

/** DRAFT -> REVIEW. Requires a complete, invariant-clean policy. */
export async function moveToReview(
  deps: CampaignDeps,
  params: { campaignId: string; userId: string; expectedVersion: number },
) {
  const { campaign, version } = await campaignInScope(deps, params.campaignId, params.userId);
  if (version.version !== params.expectedVersion) {
    fail(409, "CONFLICT", "Stale policy version", { expected: params.expectedVersion, current: version.version });
  }
  if (version.status === "REVIEW") return { campaign, version, alreadyInReview: true as const };
  if (version.status !== "DRAFT") {
    fail(400, "BAD_REQUEST", `Only a DRAFT policy can move to review (current: ${version.status})`);
  }
  const analysis = analyzePolicyFields(toFields(version));
  if (!isPolicySatisfied(analysis)) {
    fail(400, "BAD_REQUEST", "Policy is incomplete or invalid", analysis);
  }
  assertS1Transition(campaign.state, "REVIEW");
  const updatedVersion = await deps.store.updateVersion(campaign.id, version.version, { status: "REVIEW" });
  const updated = await deps.store.updateCampaign(campaign.id, { state: "REVIEW" });
  await deps.audit({
    actorType: "USER",
    actorId: params.userId,
    workspaceId: campaign.workspaceId,
    action: "campaign.review_requested",
    targetType: "campaign",
    targetId: campaign.id,
    metadata: { campaignId: campaign.id, policyVersionId: version.id, version: version.version },
  });
  return { campaign: updated, version: updatedVersion, alreadyInReview: false as const };
}

/**
 * REVIEW -> APPROVED. Owner only. Deadline must still be in the future.
 * Repeated approval of the same version is idempotent (no duplicate event).
 */
export async function approvePolicy(
  deps: CampaignDeps,
  params: { campaignId: string; userId: string; expectedVersion: number },
) {
  const { campaign, version } = await campaignInScope(deps, params.campaignId, params.userId);
  const membership = await deps.store.getMembership(campaign.workspaceId, params.userId);
  if (membership?.role !== "ORGANIZATION_OWNER") {
    fail(403, "FORBIDDEN", "Only the organization owner can approve a campaign policy");
  }
  if (version.version !== params.expectedVersion) {
    fail(409, "CONFLICT", "Stale policy version", { expected: params.expectedVersion, current: version.version });
  }
  if (version.status === "APPROVED") {
    return { campaign, version, alreadyApproved: true as const };
  }
  if (version.status !== "REVIEW") {
    fail(400, "BAD_REQUEST", `Only a REVIEW policy can be approved (current: ${version.status})`);
  }
  const now = deps.now?.() ?? new Date();
  const analysis = analyzePolicyFields(toFields(version), { checkDeadlineFuture: true, now });
  if (!isPolicySatisfied(analysis)) {
    fail(400, "BAD_REQUEST", "Policy failed approval validation", analysis);
  }
  assertS1Transition(campaign.state, "APPROVED");
  const approvedAt = now;
  const updatedVersion = await deps.store.updateVersion(campaign.id, version.version, {
    status: "APPROVED",
    approvedByUserId: params.userId,
    approvedAt,
  });
  const updated = await deps.store.updateCampaign(campaign.id, { state: "APPROVED" satisfies CampaignState });
  await deps.audit({
    actorType: "USER",
    actorId: params.userId,
    workspaceId: campaign.workspaceId,
    action: "campaign.policy_approved",
    targetType: "campaign",
    targetId: campaign.id,
    metadata: { campaignId: campaign.id, policyVersionId: version.id, version: version.version },
  });
  return { campaign: updated, version: updatedVersion, alreadyApproved: false as const };
}

export async function getCampaign(deps: CampaignDeps, params: { campaignId: string; userId: string }) {
  const { campaign, version } = await campaignInScope(deps, params.campaignId, params.userId);
  return { campaign, version };
}

export async function listWorkspaceCampaigns(
  deps: CampaignDeps,
  params: { workspaceId: string; userId: string },
) {
  await memberOrFail(deps, params.workspaceId, params.userId);
  const campaigns = await deps.store.listCampaigns(params.workspaceId);
  return { campaigns };
}
