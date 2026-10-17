import { createHash } from "node:crypto";
import { newId } from "../auth/session";
import { microToUsdcString } from "../domain/money";
import {
  DEFAULT_PRICING_POLICY,
  derivePace,
  evaluatePricing,
  type KernelInputs,
  type KernelResult,
  type PricingPolicy,
} from "../domain/pricing";
import { committedForCampaign } from "./payouts";
import type { AuditSink, MarketStore } from "./campaignStore";
import { isUniqueViolation } from "./campaignStore";

export interface PricingDeps {
  store: MarketStore;
  audit: AuditSink;
  now?: () => Date;
  policy?: Partial<PricingPolicy>;
}

function fail(status: number, code: string, message: string, details?: unknown): never {
  throw Object.assign(new Error(message), { status, code, details });
}

function fullPolicy(partial?: Partial<PricingPolicy>): PricingPolicy {
  return { ...DEFAULT_PRICING_POLICY, ...partial };
}

function inputsHash(marketVersion: number, inputs: KernelResult["inputs"]): string {
  return createHash("sha256").update(JSON.stringify([marketVersion, inputs]), "utf8").digest("hex");
}

/**
 * Deterministic explanation template. S6 ships no LLM: the Demand Agent's
 * "voice" is a fixed rendering of the kernel's codes and numbers. An LLM
 * explanation layer remains TARGET and may only ever narrate these fields.
 */
export function explainDecision(result: KernelResult): string {
  const pace = result.pace.toLowerCase().replace(/_/g, " ");
  const reasons = result.reasons.join(", ");
  if (result.decision === "REPRICE" && result.newBountyMicroUsdc !== null) {
    const oldBounty = BigInt(result.inputs.publicBountyMicroUsdc as string);
    return (
      `Market is ${pace} (${reasons}): ` +
      `adjust public bounty ${microToUsdcString(oldBounty)} → ${microToUsdcString(result.newBountyMicroUsdc)} USDC ` +
      `for future participation only. Frozen terms are unchanged.`
    );
  }
  if (result.decision === "PAUSE") {
    return `Market paused (${reasons}): no new participation or allocation. Reserved, verified, held, and reconciling outcomes are unaffected.`;
  }
  return `Market kept (${reasons}): pace is ${pace}, no price change.`;
}

interface Assembled {
  inputs: KernelInputs;
  marketVersion: number;
  versionId: string;
  workspaceId: string;
  fundingKey: string;
  policyVersion: number;
}

async function assembleInputs(
  store: MarketStore,
  campaignId: string,
  now: Date,
  policy: PricingPolicy,
): Promise<Assembled> {
  const campaign = await store.getCampaign(campaignId);
  if (!campaign) fail(404, "NOT_FOUND", "Campaign not found");
  const market = await store.getMarket(campaignId);
  if (!market) fail(404, "MARKET_NOT_OPEN", "No market for this campaign");
  const version = await store.getVersion(campaignId, market.policyVersion);
  if (!version) fail(500, "INTERNAL", "Market policy version is missing");
  if (
    version.targetOutcomeCount === null ||
    version.budgetMicroUsdc === null ||
    version.bountyFloorMicroUsdc === null ||
    version.bountyCeilingMicroUsdc === null ||
    version.deadline === null
  ) {
    fail(500, "INTERNAL", "Policy is missing economic fields");
  }
  const funding = await store.getFunding(campaignId, market.policyVersion);
  if (!funding || funding.status !== "CONFIRMED") {
    fail(400, "NOT_FUNDED", "Market has no confirmed funding for its policy version");
  }
  const committed = await committedForCampaign(store, campaignId);
  const verified = await store.countVerifiedOutcomes(campaignId);
  const since = new Date(now.getTime() - policy.demandWindowMs);
  const recentJoins = await store.countTermsSince(campaignId, since);
  const recentVerified = await store.countVerifiedOutcomesSince(campaignId, since);
  const lastRepriceAt = await store.getLastExecutedRepriceAt(campaignId);
  const funded = funding.observedAmountMicroUsdc ?? funding.expectedAmountMicroUsdc;
  const openedAtMs = market.openedAt.getTime();
  return {
    inputs: {
      publicBountyMicroUsdc: market.publicBountyMicroUsdc,
      bountyFloorMicroUsdc: version.bountyFloorMicroUsdc as bigint,
      bountyCeilingMicroUsdc: version.bountyCeilingMicroUsdc as bigint,
      fundedMicroUsdc: funded,
      committedMicroUsdc: committed,
      targetOutcomeCount: version.targetOutcomeCount as number,
      verifiedOutcomeCount: verified,
      openedAtMs,
      deadlineMs: (version.deadline as Date).getTime(),
      nowMs: now.getTime(),
      recentJoins,
      recentVerified,
      msSinceLastReprice: lastRepriceAt === null ? null : now.getTime() - lastRepriceAt.getTime(),
      marketStatus: market.status,
      campaignState: campaign.state,
    },
    marketVersion: market.version,
    versionId: version.id,
    workspaceId: campaign.workspaceId,
    fundingKey: funding.campaignKey,
    policyVersion: market.policyVersion,
  };
}

export interface EvaluationResult {
  campaignId: string;
  marketVersion: number;
  decision: string;
  pace: string;
  reasons: string[];
  oldBountyMicroUsdc: string | null;
  newBountyMicroUsdc: string | null;
  autoExecuted: boolean;
  alreadyRecorded: boolean;
  explanation: string;
}

/**
 * The Demand Agent's single decision point: run the deterministic kernel and
 * persist + execute the outcome. The agent chooses ONLY among the kernel's
 * allowed actions; bounds and eligibility are never overridable.
 */
export async function evaluateMarket(
  deps: PricingDeps,
  params: { campaignId: string },
): Promise<EvaluationResult> {
  const now = deps.now?.() ?? new Date();
  const policy = fullPolicy(deps.policy);
  const { inputs, marketVersion, versionId, workspaceId, fundingKey, policyVersion } = await assembleInputs(
    deps.store,
    params.campaignId,
    now,
    policy,
  );

  // A non-OPEN market needs no new decision: pause already holds, and KEEP
  // rows on a paused market would be audit spam. Report stored truth instead.
  const market = await deps.store.getMarket(params.campaignId);
  if (market && market.status !== "OPEN") {
    const latest = await deps.store.getLatestPricingDecision(params.campaignId);
    return {
      campaignId: params.campaignId,
      marketVersion: market.version,
      decision: "KEEP",
      pace: latest?.paceState ?? "EXHAUSTED",
      reasons: ["MARKET_NOT_OPEN"],
      oldBountyMicroUsdc: market.publicBountyMicroUsdc.toString(),
      newBountyMicroUsdc: null,
      autoExecuted: false,
      alreadyRecorded: true,
      explanation: `Market is ${market.status.toLowerCase()}: evaluation is read-only until reopened.`,
    };
  }

  const result = evaluatePricing(inputs, policy);
  const hash = inputsHash(marketVersion, result.inputs);
  const latest = await deps.store.getLatestPricingDecision(params.campaignId);
  if (latest && latest.inputsHash === hash) {
    return {
      campaignId: params.campaignId,
      marketVersion,
      decision: latest.decision,
      pace: latest.paceState,
      reasons: [...latest.reasonCodes],
      oldBountyMicroUsdc: latest.oldBountyMicroUsdc?.toString() ?? null,
      newBountyMicroUsdc: latest.newBountyMicroUsdc?.toString() ?? null,
      autoExecuted: latest.autoExecuted,
      alreadyRecorded: true,
      explanation: explainDecision(result),
    };
  }

  // Crash-safe single unit: market mutation + decision row commit together.
  // A concurrent evaluator that commits first wins; the loser returns the
  // winner's row (unique hash) or the fresh latest on STALE version.
  const persisted = await deps.store.atomic(deps.audit, async ({ store, audit }) => {
    const ms = store as MarketStore;
    if (result.decision === "KEEP") {
      const row = await ms.insertPricingDecision({
        id: newId(),
        campaignId: params.campaignId,
        marketVersion,
        decision: "KEEP",
        paceState: result.pace,
        reasonCodes: [...result.reasons],
        inputsJson: result.inputs as Record<string, unknown>,
        inputsHash: hash,
        oldBountyMicroUsdc: inputs.publicBountyMicroUsdc,
        newBountyMicroUsdc: null,
        autoExecuted: false,
      });
      await audit({
        actorType: "AGENT", actorId: null, workspaceId,
        action: "pricing.decision", targetType: "market", targetId: params.campaignId,
        metadata: {
          campaignId: params.campaignId, marketVersion, decision: "KEEP", pace: result.pace,
          reasons: result.reasons, inputsHash: hash, autoExecuted: false,
        },
      });
      return { row, executed: false as const };
    }
    const patch =
      result.decision === "REPRICE"
        ? { publicBountyMicroUsdc: result.newBountyMicroUsdc as bigint, version: marketVersion + 1 }
        : { status: "PAUSED" as const, version: marketVersion + 1 };
    const updated = await ms.updateMarket(params.campaignId, marketVersion, patch);
    const row = await ms.insertPricingDecision({
      id: newId(),
      campaignId: params.campaignId,
      marketVersion,
      decision: result.decision,
      paceState: result.pace,
      reasonCodes: [...result.reasons],
      inputsJson: result.inputs as Record<string, unknown>,
      inputsHash: hash,
      oldBountyMicroUsdc: inputs.publicBountyMicroUsdc,
      newBountyMicroUsdc: result.newBountyMicroUsdc,
      autoExecuted: true,
    });
    await audit({
      actorType: "AGENT", actorId: null, workspaceId,
      action: result.decision === "REPRICE" ? "pricing.repriced" : "pricing.paused",
      targetType: "market", targetId: params.campaignId,
      metadata: {
        campaignId: params.campaignId, marketVersion, newMarketVersion: updated.version,
        decision: result.decision, pace: result.pace, reasons: result.reasons,
        oldBountyMicroUsdc: inputs.publicBountyMicroUsdc.toString(),
        newBountyMicroUsdc: result.newBountyMicroUsdc?.toString() ?? null,
        inputsHash: hash, policyVersion, fundingKey, autoExecuted: true,
      },
    });
    return { row, executed: true as const };
  }).catch(async (e) => {
    if ((e as { code?: string })?.code === "UNIQUE_VIOLATION" || (e as { code?: string })?.code === "STALE_MARKET") {
      const winner = await deps.store.getLatestPricingDecision(params.campaignId);
      if (!winner) throw e;
      return { row: winner, executed: winner.autoExecuted, raced: true as const };
    }
    throw e;
  });

  return {
    campaignId: params.campaignId,
    marketVersion,
    decision: persisted.row.decision,
    pace: persisted.row.paceState,
    reasons: [...persisted.row.reasonCodes],
    oldBountyMicroUsdc: persisted.row.oldBountyMicroUsdc?.toString() ?? null,
    newBountyMicroUsdc: persisted.row.newBountyMicroUsdc?.toString() ?? null,
    autoExecuted: persisted.row.autoExecuted,
    alreadyRecorded: (persisted as { raced?: boolean }).raced ?? false,
    explanation: explainDecision(result),
  };
}

export interface WorkerSummary {
  evaluated: number;
  decisions: Array<{ campaignId: string; decision: string; pace: string }>;
  failed: Array<{ campaignId: string; error: string }>;
}

/** Evaluate every OPEN market (or an explicit list). Isolated per market. */
export async function processPricingEvaluations(
  deps: PricingDeps,
  opts?: { campaignIds?: string[]; limit?: number },
): Promise<WorkerSummary> {
  const summary: WorkerSummary = { evaluated: 0, decisions: [], failed: [] };
  let targets = opts?.campaignIds ?? [];
  if (targets.length === 0) {
    const markets = await deps.store.listMarkets();
    targets = markets.filter((m) => m.status === "OPEN").map((m) => m.campaignId).slice(0, opts?.limit ?? 25);
  }
  for (const campaignId of targets) {
    try {
      const r = await evaluateMarket(deps, { campaignId });
      summary.evaluated += 1;
      summary.decisions.push({ campaignId, decision: r.decision, pace: r.pace });
    } catch (e) {
      summary.failed.push({ campaignId, error: (e as Error).message });
    }
  }
  return summary;
}

/** Read model for UI/debugging: live pace + last decision + cooldown state. */
export async function getMarketPricingState(deps: PricingDeps, params: { campaignId: string }) {
  const now = deps.now?.() ?? new Date();
  const policy = fullPolicy(deps.policy);
  const market = await deps.store.getMarket(params.campaignId);
  if (!market) fail(404, "MARKET_NOT_OPEN", "No market for this campaign");
  const latest = await deps.store.getLatestPricingDecision(params.campaignId);
  let pace: string = latest?.paceState ?? "ON_PACE";
  let inputs: KernelInputs | null = null;
  try {
    const assembled = await assembleInputs(deps.store, params.campaignId, now, policy);
    inputs = assembled.inputs;
    pace = derivePace(assembled.inputs, policy);
  } catch {
    // Unassemblable state (e.g. missing funding): report stored truth only.
  }
  const lastRepriceAt = await deps.store.getLastExecutedRepriceAt(params.campaignId);
  const nextEligibleAt =
    lastRepriceAt === null ? null : new Date(lastRepriceAt.getTime() + policy.cooldownMs).toISOString();
  return {
    campaignId: params.campaignId,
    status: market.status,
    publicBountyMicroUsdc: market.publicBountyMicroUsdc.toString(),
    marketVersion: market.version,
    pace,
    lastDecision: latest
      ? {
          decision: latest.decision,
          paceState: latest.paceState,
          reasonCodes: [...latest.reasonCodes],
          oldBountyMicroUsdc: latest.oldBountyMicroUsdc?.toString() ?? null,
          newBountyMicroUsdc: latest.newBountyMicroUsdc?.toString() ?? null,
          autoExecuted: latest.autoExecuted,
          createdAt: latest.createdAt.toISOString(),
        }
      : null,
    lastEvaluatedAt: latest?.createdAt.toISOString() ?? null,
    nextEligibleAt,
    cooldownMs: policy.cooldownMs,
    inputs: inputs
      ? {
          verifiedOutcomeCount: inputs.verifiedOutcomeCount,
          targetOutcomeCount: inputs.targetOutcomeCount,
          fundedMicroUsdc: inputs.fundedMicroUsdc.toString(),
          committedMicroUsdc: inputs.committedMicroUsdc.toString(),
          recentJoins: inputs.recentJoins,
          recentVerified: inputs.recentVerified,
        }
      : null,
  };
}
