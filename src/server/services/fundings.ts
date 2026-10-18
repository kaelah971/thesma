import {
  arcConfigFromEnv,
  assertChainMatches,
  buildFundingIntent,
  isTxHash,
  normalizeAddress,
  type ArcChainReader,
  type ArcConfig,
  type TxReceiptSummary,
  type UnsignedAction,
} from "../chain/arc";
import { campaignKeyFor, policyHashFor, type Hex32 } from "../chain/keys";
import { newId } from "../auth/session";
import { campaignInScope } from "./campaigns";
import type { AuditSink, FundingStore, StoredFunding } from "./campaignStore";
import type { CampaignPolicyVersion } from "../domain/campaign";

export interface FundingDeps {
  store: FundingStore;
  audit: AuditSink;
  config: ArcConfig | null;
  reader: ArcChainReader | null;
  now?: () => Date;
}

export function fundingDepsFromEnv(store: FundingStore, audit: AuditSink, reader: ArcChainReader | null): FundingDeps {
  return { store, audit, config: arcConfigFromEnv(), reader };
}

function fail(status: number, code: string, message: string, details?: unknown): never {
  throw Object.assign(new Error(message), { status, code, details });
}

async function ownerOrFail(deps: FundingDeps, workspaceId: string, userId: string) {
  const m = await deps.store.getMembership(workspaceId, userId);
  if (!m) fail(403, "FORBIDDEN", "Not a workspace member");
  if (m.role !== "ORGANIZATION_OWNER") fail(403, "FORBIDDEN", "Owner-only operation");
  return m;
}

interface CompletePolicy {
  targetOutcomeCount: number;
  budgetMicroUsdc: bigint;
  bountyFloorMicroUsdc: bigint;
  bountyCeilingMicroUsdc: bigint;
  minQualifyingPurchaseMicroUsdc: bigint;
  deadline: Date;
}

/** APPROVED policies are complete by construction; refuse to proceed otherwise. */
function requireCompletePolicy(version: CampaignPolicyVersion): CompletePolicy {
  const v = version;
  if (
    v.targetOutcomeCount === null ||
    v.budgetMicroUsdc === null ||
    v.bountyFloorMicroUsdc === null ||
    v.bountyCeilingMicroUsdc === null ||
    v.minQualifyingPurchaseMicroUsdc === null ||
    v.deadline === null
  ) {
    fail(500, "INTERNAL", "Approved policy is missing required economic fields");
  }
  return {
    targetOutcomeCount: v.targetOutcomeCount as number,
    budgetMicroUsdc: v.budgetMicroUsdc as bigint,
    bountyFloorMicroUsdc: v.bountyFloorMicroUsdc as bigint,
    bountyCeilingMicroUsdc: v.bountyCeilingMicroUsdc as bigint,
    minQualifyingPurchaseMicroUsdc: v.minQualifyingPurchaseMicroUsdc as bigint,
    deadline: v.deadline as Date,
  };
}

function bindingsFor(
  campaignId: string,
  version: CampaignPolicyVersion,
  complete: CompletePolicy,
  companyWallet: string,
): { campaignKey: Hex32; policyHash: Hex32 } {
  return {
    campaignKey: campaignKeyFor(campaignId, version.version),
    policyHash: policyHashFor({
      campaignId,
      policyVersion: version.version,
      ...complete,
      marketVisibility: version.marketVisibility,
      refundHoldSeconds: version.refundHoldSeconds,
      allowedPartnerRules: version.allowedPartnerRulesJson,
      escalationRules: version.escalationRulesJson,
      companyWallet,
    }),
  };
}

export function serializeFunding(f: StoredFunding) {
  return {
    ...f,
    expectedAmountMicroUsdc: f.expectedAmountMicroUsdc.toString(),
    observedAmountMicroUsdc: f.observedAmountMicroUsdc === null ? null : f.observedAmountMicroUsdc.toString(),
    submittedAt: f.submittedAt?.toISOString() ?? null,
    confirmedAt: f.confirmedAt?.toISOString() ?? null,
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt.toISOString(),
  };
}

/**
 * Register (not verify) the expected company Arc address. Owner-only.
 * Funding evidence later must come FROM this exact address; typing it here
 * proves nothing cryptographic by itself.
 */
export async function registerCompanyWallet(
  deps: FundingDeps,
  params: { workspaceId: string; userId: string; address: string },
) {
  await ownerOrFail(deps, params.workspaceId, params.userId);
  const normalized = normalizeAddress(params.address);
  const workspace = await deps.store.atomic(deps.audit, async ({ store, audit }) => {
    const ws = await store.setCompanyWallet(params.workspaceId, normalized);
    await audit({
      actorType: "USER",
      actorId: params.userId,
      workspaceId: params.workspaceId,
      action: "workspace.company_wallet_registered",
      targetType: "workspace",
      targetId: params.workspaceId,
      metadata: { workspaceId: params.workspaceId, companyWallet: normalized },
    });
    return ws;
  });
  return { workspace };
}

/**
 * APPROVED -> FUNDING + PREPARED funding record, atomically.
 * Returns unsigned owner actions only. The backend never signs.
 */
export async function prepareFundingIntent(
  deps: FundingDeps,
  params: { campaignId: string; userId: string; expectedVersion: number },
): Promise<{
  campaign: { id: string; state: string };
  funding: ReturnType<typeof serializeFunding>;
  actions: UnsignedAction[];
  campaignKey: Hex32;
  policyHash: Hex32;
}> {
  const { campaign, version } = await campaignInScope(deps, params.campaignId, params.userId);
  await ownerOrFail(deps, campaign.workspaceId, params.userId);
  if (version.version !== params.expectedVersion) {
    fail(409, "CONFLICT", "Stale policy version", { expected: params.expectedVersion, current: version.version });
  }
  if (campaign.state !== "APPROVED" || version.status !== "APPROVED") {
    fail(400, "BAD_REQUEST", "Only an APPROVED policy can be funded");
  }
  const workspace = await deps.store.getWorkspace(campaign.workspaceId);
  if (!workspace?.companyWallet) fail(400, "COMPANY_WALLET_REQUIRED", "Register the company Arc address first");
  if (!deps.config) fail(503, "ARC_UNCONFIGURED", "Arc chain configuration is absent");
  if (!deps.config.vaultAddress) fail(400, "VAULT_UNCONFIGURED", "THESMA_VAULT_ADDRESS is not configured");

  const existing = await deps.store.getFunding(campaign.id, version.version);
  if (existing && existing.status === "CONFIRMED") fail(409, "ALREADY_FUNDED", "This policy version is already funded");
  if (existing && existing.status !== "FAILED") {
    fail(409, "FUNDING_IN_PROGRESS", "A funding flow is already active for this policy version");
  }

  const complete = requireCompletePolicy(version);
  const { campaignKey, policyHash } = bindingsFor(campaign.id, version, complete, workspace.companyWallet);

  // Best-effort onchain existence check: unknown (no reader / RPC error)
  // safely defaults to including the create step.
  let campaignExistsOnchain = false;
  if (deps.reader && deps.config.vaultAddress) {
    try {
      const onchain = await deps.reader.readVaultCampaign(deps.config.vaultAddress, campaignKey);
      campaignExistsOnchain =
        onchain.exists && onchain.policyHash?.toLowerCase() === policyHash.toLowerCase();
    } catch {
      campaignExistsOnchain = false;
    }
  }

  const actions = buildFundingIntent({
    config: deps.config,
    ownerAddress: normalizeAddress(workspace.companyWallet),
    campaignKey,
    policyHash,
    budgetMicroUsdc: complete.budgetMicroUsdc,
    bountyCeilingMicroUsdc: complete.bountyCeilingMicroUsdc,
    deadlineUnix: BigInt(Math.floor(complete.deadline.getTime() / 1000)),
    executorAddress: deps.config.executorAddress,
    verifierAddress: deps.config.verifierAddress,
    campaignExistsOnchain,
  });

  const now = deps.now?.() ?? new Date();
  const outcome = await deps.store.atomic(deps.audit, async ({ store, audit }) => {
    const updated = await store.updateCampaign(campaign.id, { state: "FUNDING" });
    const funding = existing
      ? await store.updateFunding(campaign.id, version.version, {
          status: "PREPARED",
          campaignKey,
          createTxHash: null,
          approveTxHash: null,
          fundingTxHash: null,
          blockNumber: null,
          observedAmountMicroUsdc: null,
          failureCode: null,
          submittedAt: null,
          confirmedAt: null,
        } satisfies Partial<StoredFunding>)
      : await store.insertFunding({
          id: newId(),
          campaignId: campaign.id,
          policyVersionId: version.id,
          policyVersion: version.version,
          campaignKey,
          policyHash,
          chainId: deps.config!.chainId,
          vaultAddress: deps.config!.vaultAddress!,
          usdcAddress: deps.config!.usdcAddress,
          ownerAddress: normalizeAddress(workspace.companyWallet!),
          expectedAmountMicroUsdc: complete.budgetMicroUsdc,
        });
    void now;
    await audit({
      actorType: "USER",
      actorId: params.userId,
      workspaceId: campaign.workspaceId,
      action: "campaign.funding_prepared",
      targetType: "campaign",
      targetId: campaign.id,
      metadata: {
        campaignId: campaign.id,
        policyVersionId: version.id,
        version: version.version,
        campaignKey,
        policyHash,
        chainId: deps.config!.chainId,
        expectedAmountMicroUsdc: complete.budgetMicroUsdc.toString(),
        actions: actions.map((a) => a.purpose),
      },
    });
    return { updated, funding };
  });
  return {
    campaign: { id: outcome.updated.id, state: outcome.updated.state },
    funding: serializeFunding(outcome.funding),
    actions,
    campaignKey,
    policyHash,
  };
}

export interface ResumeFundingResult {
  campaign: { id: string; state: string };
  funding: ReturnType<typeof serializeFunding>;
  actions: UnsignedAction[];
  campaignKey: Hex32;
  policyHash: Hex32;
  completed: Array<"create-campaign" | "approve-usdc" | "fund-campaign">;
  /** A successful fund-campaign receipt is already recorded: do not resend, reconcile instead. */
  confirmReady: boolean;
}

/**
 * Resume an in-flight funding flow WITHOUT mutating anything.
 *
 * Read-only: never creates a funding row, never changes bindings, never clears
 * recorded hashes. Rebuilds the canonical remaining unsigned actions from the
 * stored funding record + current approved policy + live onchain state.
 *
 * Already-completed steps are omitted (never blindly resent). Any recorded
 * transaction without a success receipt fails closed (TX_AMBIGUOUS or
 * TX_REVERTED) so the UI surfaces it instead of guessing.
 */
export async function resumeFundingIntent(
  deps: FundingDeps,
  params: { campaignId: string; userId: string; expectedVersion: number },
): Promise<ResumeFundingResult> {
  const { campaign, version } = await campaignInScope(deps, params.campaignId, params.userId);
  await ownerOrFail(deps, campaign.workspaceId, params.userId);
  if (version.version !== params.expectedVersion) {
    fail(409, "CONFLICT", "Stale policy version", { expected: params.expectedVersion, current: version.version });
  }
  const funding = await deps.store.getFunding(campaign.id, version.version);
  if (!funding) fail(404, "NOT_FOUND", "No funding flow exists for this policy version; prepare one first");
  if (funding.status === "CONFIRMED") fail(409, "ALREADY_FUNDED", "This policy version is already funded");
  if (funding.status === "FAILED") fail(400, "BAD_REQUEST", "Funding failed: prepare a fresh intent first");
  if (campaign.state !== "APPROVED" && campaign.state !== "FUNDING") {
    fail(400, "BAD_REQUEST", "Only an APPROVED or FUNDING campaign can resume funding");
  }
  const workspace = await deps.store.getWorkspace(campaign.workspaceId);
  if (!workspace?.companyWallet) fail(400, "COMPANY_WALLET_REQUIRED", "Register the company Arc address first");
  if (!deps.config) fail(503, "ARC_UNCONFIGURED", "Arc chain configuration is absent");
  if (!deps.config.vaultAddress) fail(400, "VAULT_UNCONFIGURED", "THESMA_VAULT_ADDRESS is not configured");

  const complete = requireCompletePolicy(version);
  const { campaignKey, policyHash } = bindingsFor(campaign.id, version, complete, workspace.companyWallet);
  if (
    funding.campaignKey.toLowerCase() !== campaignKey.toLowerCase() ||
    funding.policyHash.toLowerCase() !== policyHash.toLowerCase()
  ) {
    fail(409, "BINDING_MISMATCH", "Stored funding bindings differ from the approved policy; refusing to resume");
  }

  let onchainExists = false;
  if (deps.reader && deps.config.vaultAddress) {
    try {
      const onchain = await deps.reader.readVaultCampaign(deps.config.vaultAddress, campaignKey);
      onchainExists = onchain.exists && onchain.policyHash?.toLowerCase() === policyHash.toLowerCase();
    } catch {
      onchainExists = false;
    }
  }

  const receiptFor = async (txHash: string, purpose: string): Promise<TxReceiptSummary> => {
    if (!deps.reader) fail(503, "CHAIN_UNAVAILABLE", "Cannot verify recorded transactions without a chain reader");
    let receipt: TxReceiptSummary | null;
    try {
      receipt = await deps.reader.getReceipt(txHash as `0x${string}`);
    } catch {
      fail(503, "CHAIN_UNAVAILABLE", "Chain read failed while verifying a recorded transaction", { purpose, txHash });
    }
    if (!receipt) {
      fail(409, "TX_AMBIGUOUS", "Recorded transaction has no receipt yet; refusing to continue blindly", {
        purpose,
        txHash,
      });
    }
    return receipt;
  };

  let createDone = onchainExists;
  if (funding.createTxHash) {
    const rc = await receiptFor(funding.createTxHash, "create-campaign");
    if (rc.status !== "success") {
      fail(409, "TX_REVERTED", "Recorded create-campaign transaction reverted onchain", {
        txHash: funding.createTxHash,
      });
    }
    if (!onchainExists) {
      fail(409, "TX_AMBIGUOUS", "Create succeeded but the campaign is not registered onchain under these bindings", {
        txHash: funding.createTxHash,
      });
    }
    createDone = true;
  }
  let approveDone = false;
  if (funding.approveTxHash) {
    const rc = await receiptFor(funding.approveTxHash, "approve-usdc");
    if (rc.status !== "success") {
      fail(409, "TX_REVERTED", "Recorded approve transaction reverted onchain", {
        txHash: funding.approveTxHash,
      });
    }
    approveDone = true;
  }
  let fundDone = false;
  if (funding.fundingTxHash) {
    const rc = await receiptFor(funding.fundingTxHash, "fund-campaign");
    if (rc.status !== "success") {
      fail(409, "TX_REVERTED", "Recorded fund transaction reverted onchain", {
        txHash: funding.fundingTxHash,
      });
    }
    fundDone = true;
  }

  const actions = buildFundingIntent({
    config: deps.config,
    ownerAddress: normalizeAddress(workspace.companyWallet!),
    campaignKey,
    policyHash,
    budgetMicroUsdc: complete.budgetMicroUsdc,
    bountyCeilingMicroUsdc: complete.bountyCeilingMicroUsdc,
    deadlineUnix: BigInt(Math.floor(complete.deadline.getTime() / 1000)),
    executorAddress: deps.config.executorAddress,
    verifierAddress: deps.config.verifierAddress,
    campaignExistsOnchain: createDone,
  }).filter((a) =>
    a.purpose === "create-campaign" ? !createDone : a.purpose === "approve-usdc" ? !approveDone : !fundDone,
  );

  const completed: ResumeFundingResult["completed"] = [];
  if (createDone) completed.push("create-campaign");
  if (approveDone) completed.push("approve-usdc");
  if (fundDone) completed.push("fund-campaign");
  return {
    campaign: { id: campaign.id, state: campaign.state },
    funding: serializeFunding(funding),
    actions,
    campaignKey,
    policyHash,
    completed,
    confirmReady: fundDone,
  };
}

/** Record owner-submitted transaction hashes. Format-checked, never trusted as confirmation. */
export async function recordFundingSubmitted(
  deps: FundingDeps,
  params: {
    campaignId: string;
    userId: string;
    expectedVersion: number;
    createTxHash?: string;
    approveTxHash?: string;
    fundingTxHash?: string;
  },
) {
  for (const [name, value] of Object.entries({
    createTxHash: params.createTxHash,
    approveTxHash: params.approveTxHash,
    fundingTxHash: params.fundingTxHash,
  })) {
    if (value !== undefined && !isTxHash(value)) fail(400, "BAD_REQUEST", `Malformed transaction hash: ${name}`);
  }
  if (!params.createTxHash && !params.approveTxHash && !params.fundingTxHash) {
    fail(400, "BAD_REQUEST", "At least one transaction hash is required");
  }
  const { campaign, version } = await campaignInScope(deps, params.campaignId, params.userId);
  await ownerOrFail(deps, campaign.workspaceId, params.userId);
  if (version.version !== params.expectedVersion) {
    fail(409, "CONFLICT", "Stale policy version", { expected: params.expectedVersion, current: version.version });
  }
  const funding = await deps.store.getFunding(campaign.id, version.version);
  if (!funding) fail(404, "NOT_FOUND", "No funding intent exists for this policy version");
  if (funding.status === "CONFIRMED") fail(409, "ALREADY_FUNDED", "Funding is already confirmed");
  if (funding.status === "FAILED") fail(400, "BAD_REQUEST", "Funding failed: prepare a fresh intent first");

  const now = deps.now?.() ?? new Date();
  const updated = await deps.store.atomic(deps.audit, async ({ store, audit }) => {
    const next = await store.updateFunding(campaign.id, version.version, {
      status: "SUBMITTED",
      createTxHash: params.createTxHash ?? funding.createTxHash,
      approveTxHash: params.approveTxHash ?? funding.approveTxHash,
      fundingTxHash: params.fundingTxHash ?? funding.fundingTxHash,
      submittedAt: now,
    });
    await audit({
      actorType: "USER",
      actorId: params.userId,
      workspaceId: campaign.workspaceId,
      action: "campaign.funding_submitted",
      targetType: "campaign",
      targetId: campaign.id,
      metadata: {
        campaignId: campaign.id,
        policyVersionId: version.id,
        version: version.version,
        campaignKey: funding.campaignKey,
        chainId: funding.chainId,
        fundingTxHash: next.fundingTxHash,
      },
    });
    return next;
  });
  return { funding: serializeFunding(updated) };
}

export async function getFundingStatus(
  deps: FundingDeps,
  params: { campaignId: string; userId: string; expectedVersion?: number },
) {
  const { campaign, version } = await campaignInScope(deps, params.campaignId, params.userId);
  const target = params.expectedVersion ?? version.version;
  const funding = await deps.store.getFunding(campaign.id, target);
  if (!funding) fail(404, "NOT_FOUND", "No funding record for this policy version");
  return { funding: serializeFunding(funding) };
}

async function markFailed(
  deps: FundingDeps,
  campaignId: string,
  workspaceId: string,
  userId: string,
  version: { id: string; version: number },
  campaignKey: string,
  chainId: number,
  failureCode: string,
  details?: unknown,
) {
  // A FAILED confirmation proves nothing moved: return the campaign to APPROVED
  // so the owner can revise (new version) or prepare a fresh intent.
  const updated = await deps.store.atomic(deps.audit, async ({ store, audit }) => {
    const next = await store.updateFunding(campaignId, version.version, { status: "FAILED", failureCode });
    await store.updateCampaign(campaignId, { state: "APPROVED" });
    await audit({
      actorType: "USER",
      actorId: userId,
      workspaceId,
      action: "campaign.funding_failed",
      targetType: "campaign",
      targetId: campaignId,
      metadata: { campaignId, policyVersionId: version.id, version: version.version, campaignKey, chainId, failureCode, details },
    });
    return next;
  });
  return updated;
}

/**
 * Owner-triggered reconciliation. Reads Arc, trusts nothing from the request
 * body. LIVE only after deterministic onchain proof; unclear state becomes
 * AMBIGUOUS (never blind success, never blind retry).
 */
export async function confirmFunding(
  deps: FundingDeps,
  params: { campaignId: string; userId: string; expectedVersion?: number },
) {
  const { campaign, version } = await campaignInScope(deps, params.campaignId, params.userId);
  await ownerOrFail(deps, campaign.workspaceId, params.userId);
  const target = params.expectedVersion ?? version.version;
  if (version.version !== target) {
    fail(409, "CONFLICT", "Stale policy version", { expected: target, current: version.version });
  }
  const funding = await deps.store.getFunding(campaign.id, target);
  if (!funding) fail(404, "NOT_FOUND", "No funding record for this policy version");
  if (funding.status === "CONFIRMED") {
    return { funding: serializeFunding(funding), campaign: { id: campaign.id, state: campaign.state }, alreadyConfirmed: true as const };
  }
  if (funding.status === "FAILED") fail(400, "BAD_REQUEST", "Funding failed: prepare a fresh intent first");
  if (!deps.config || !deps.reader) fail(503, "ARC_UNCONFIGURED", "Chain reader is required for confirmation");
  if (!funding.fundingTxHash || !isTxHash(funding.fundingTxHash)) {
    fail(400, "BAD_REQUEST", "No funding transaction hash recorded yet");
  }

  const failWith = async (code: string, details?: unknown) => {
    const updated = await markFailed(deps, campaign.id, campaign.workspaceId, params.userId, version, funding.campaignKey, funding.chainId, code, details);
    return { funding: serializeFunding(updated), campaign: { id: campaign.id, state: campaign.state }, confirmed: false as const, failureCode: code };
  };

  try {
    await assertChainMatches(deps.reader, funding.chainId);
  } catch (e) {
    return failWith("CHAIN_MISMATCH", (e as Error).message);
  }

  const receipt = await deps.reader.getReceipt(funding.fundingTxHash);
  if (!receipt) {
    const updated = await deps.store.atomic(deps.audit, async ({ store, audit }) => {
      const next = await store.updateFunding(campaign.id, target, { status: "AMBIGUOUS", failureCode: "RECEIPT_UNKNOWN" });
      await audit({
        actorType: "USER",
        actorId: params.userId,
        workspaceId: campaign.workspaceId,
        action: "campaign.funding_ambiguous",
        targetType: "campaign",
        targetId: campaign.id,
        metadata: { campaignId: campaign.id, policyVersionId: version.id, version: version.version, campaignKey: funding.campaignKey, chainId: funding.chainId, fundingTxHash: funding.fundingTxHash },
      });
      return next;
    });
    return { funding: serializeFunding(updated), campaign: { id: campaign.id, state: campaign.state }, confirmed: false as const, ambiguous: true as const };
  }
  if (receipt.status !== "success") return failWith("TX_REVERTED", { txHash: funding.fundingTxHash });
  if (!receipt.to || receipt.to.toLowerCase() !== funding.vaultAddress.toLowerCase()) {
    return failWith("WRONG_VAULT", { to: receipt.to, expected: funding.vaultAddress });
  }
  const keyEvents = receipt.fundedEvents.filter((e) => e.campaignKey.toLowerCase() === funding.campaignKey.toLowerCase());
  if (keyEvents.length === 0) return failWith("NO_FUNDING_EVENT", { txHash: funding.fundingTxHash });

  const onchain = await deps.reader.readVaultCampaign(
    normalizeAddress(funding.vaultAddress),
    funding.campaignKey as Hex32,
  );
  if (!onchain.exists) return failWith("UNKNOWN_CAMPAIGN", { campaignKey: funding.campaignKey });
  if (!onchain.owner || onchain.owner.toLowerCase() !== funding.ownerAddress.toLowerCase()) {
    return failWith("WRONG_OWNER", { owner: onchain.owner, expected: funding.ownerAddress });
  }
  if (!onchain.policyHash || onchain.policyHash.toLowerCase() !== funding.policyHash.toLowerCase()) {
    return failWith("POLICY_MISMATCH", { onchain: onchain.policyHash, expected: funding.policyHash });
  }
  if (onchain.funded < funding.expectedAmountMicroUsdc) {
    return failWith("UNDERFUNDED", { funded: onchain.funded.toString(), expected: funding.expectedAmountMicroUsdc.toString() });
  }

  // The confirmed version must still be the campaign's current version.
  const current = await deps.store.getCurrentVersion(campaign.id);
  if (!current || current.id !== funding.policyVersionId) {
    return failWith("POLICY_SUPERSEDED", { currentPolicyVersionId: current?.id ?? null });
  }

  const now = deps.now?.() ?? new Date();
  const outcome = await deps.store.atomic(deps.audit, async ({ store, audit }) => {
    const next = await store.updateFunding(campaign.id, target, {
      status: "CONFIRMED",
      observedAmountMicroUsdc: onchain.funded,
      blockNumber: Number(receipt.blockNumber),
      failureCode: null,
      confirmedAt: now,
    });
    const live = await store.updateCampaign(campaign.id, { state: "LIVE" });
    const base = { campaignId: campaign.id, policyVersionId: version.id, version: version.version, campaignKey: funding.campaignKey, chainId: funding.chainId, fundingTxHash: funding.fundingTxHash, blockNumber: Number(receipt.blockNumber), observedAmountMicroUsdc: onchain.funded.toString() };
    await audit({ actorType: "USER", actorId: params.userId, workspaceId: campaign.workspaceId, action: "campaign.funding_confirmed", targetType: "campaign", targetId: campaign.id, metadata: base });
    await audit({ actorType: "USER", actorId: params.userId, workspaceId: campaign.workspaceId, action: "campaign.live", targetType: "campaign", targetId: campaign.id, metadata: base });
    return { next, live };
  });
  return {
    funding: serializeFunding(outcome.next),
    campaign: { id: outcome.live.id, state: outcome.live.state },
    alreadyConfirmed: false as const,
    confirmed: true as const,
  };
}
