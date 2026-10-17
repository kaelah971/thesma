import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb, isDbConfigured } from "@/server/db/client";
import {
  auditEvents,
  campaignFundings,
  campaignPolicyVersions,
  campaigns,
  marketStates,
  outcomes,
  payouts,
  spendReservations,
  supplyCommitments,
} from "@/server/db/schema";
import { getSessionUser } from "@/server/auth/guard";
import { listUserWorkspaces } from "@/server/services/workspaces";
import type { CampaignView, FundingView, WorkspaceSnapshot } from "@/lib/readmodel";

/**
 * Read-only UI loaders for the authenticated app. Every query is scoped to a
 * workspace the session user is a member of — no client-supplied identity.
 * No writes happen here; mutations go through the existing /api routes.
 */

export const WORKSPACE_COOKIE = "thesma_workspace";

export type AppSession =
  | { kind: "unconfigured" }
  | {
      kind: "ok";
      user: { userId: string; email: string; name: string | null };
      workspaces: { id: string; name: string; role: string; companyWallet: string | null; category: string | null }[];
      current: { id: string; name: string; role: string; companyWallet: string | null; category: string | null } | null;
    };

export const getAppSession = cache(async (): Promise<AppSession> => {
  if (!isDbConfigured()) return { kind: "unconfigured" };
  const user = await getSessionUser();
  if (!user) redirect("/signin");
  const rows = await listUserWorkspaces(user.userId);
  const workspaces = rows.map((r) => ({
    id: r.workspace.id,
    name: r.workspace.name,
    role: r.role,
    companyWallet: r.workspace.companyWallet,
    category: r.workspace.category,
  }));
  const preferred = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  const current = workspaces.find((w) => w.id === preferred) ?? workspaces[0] ?? null;
  return { kind: "ok", user, workspaces, current };
});

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const str = (v: bigint | null | undefined) => (v === null || v === undefined ? null : v.toString());

export const loadSnapshot = cache(async (workspaceId: string): Promise<WorkspaceSnapshot> => {
  const session = await getAppSession();
  if (session.kind !== "ok") throw new Error("Session unavailable");
  const workspace = session.workspaces.find((w) => w.id === workspaceId);
  if (!workspace) redirect("/app");

  const db = getDb();
  const campaignRows = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.workspaceId, workspaceId))
    .orderBy(desc(campaigns.createdAt));
  const ids = campaignRows.map((c) => c.id);

  const empty = ids.length === 0;
  const [versions, fundings, markets, outcomeRows, reservationRows, payoutRows, commitmentRows, activityRows] = await Promise.all([
    empty ? [] : db.select().from(campaignPolicyVersions).where(inArray(campaignPolicyVersions.campaignId, ids)),
    empty ? [] : db.select().from(campaignFundings).where(inArray(campaignFundings.campaignId, ids)),
    empty ? [] : db.select().from(marketStates).where(inArray(marketStates.campaignId, ids)),
    empty ? [] : db.select().from(outcomes).where(inArray(outcomes.campaignId, ids)).orderBy(desc(outcomes.createdAt)).limit(500),
    empty ? [] : db.select().from(spendReservations).where(inArray(spendReservations.campaignId, ids)),
    empty ? [] : db.select().from(payouts).where(inArray(payouts.campaignId, ids)).orderBy(desc(payouts.createdAt)).limit(500),
    empty
      ? []
      : db
          .select({ campaignId: supplyCommitments.campaignId, amount: supplyCommitments.amountMicroUsdc })
          .from(supplyCommitments)
          .where(and(inArray(supplyCommitments.campaignId, ids), eq(supplyCommitments.state, "ACTIVE"))),
    db.select().from(auditEvents).where(eq(auditEvents.workspaceId, workspaceId)).orderBy(desc(auditEvents.createdAt)).limit(150),
  ]);

  const campaignViews: CampaignView[] = campaignRows.map((c) => {
    const version = versions.find((v) => v.id === c.currentPolicyVersionId) ?? null;
    const funding = version ? fundings.find((f) => f.campaignId === c.id && f.policyVersion === version.version) : undefined;
    const market = markets.find((m) => m.campaignId === c.id);
    const fundingView: FundingView | null = funding
      ? {
          status: funding.status,
          policyVersion: funding.policyVersion,
          expectedMicro: funding.expectedAmountMicroUsdc.toString(),
          observedMicro: str(funding.observedAmountMicroUsdc),
          fundingTxHash: funding.fundingTxHash,
          confirmedAt: iso(funding.confirmedAt),
          failureCode: funding.failureCode,
        }
      : null;
    return {
      id: c.id,
      state: c.state,
      intentText: version?.intentText ?? "",
      version: version?.version ?? null,
      policyStatus: version?.status ?? null,
      targetOutcomeCount: version?.targetOutcomeCount ?? null,
      budgetMicro: str(version?.budgetMicroUsdc),
      floorMicro: str(version?.bountyFloorMicroUsdc),
      ceilingMicro: str(version?.bountyCeilingMicroUsdc),
      minPurchaseMicro: str(version?.minQualifyingPurchaseMicroUsdc),
      deadline: iso(version?.deadline),
      refundHoldSeconds: version?.refundHoldSeconds ?? 0,
      visibility: version?.marketVisibility ?? "PUBLIC",
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
      funding: fundingView,
      market: market
        ? { status: market.status, bountyMicro: market.publicBountyMicroUsdc.toString(), version: market.version, openedAt: market.openedAt.toISOString() }
        : null,
    };
  });

  return {
    workspace,
    campaigns: campaignViews,
    outcomes: outcomeRows.map((o) => ({
      id: o.id,
      campaignId: o.campaignId,
      partnerId: o.partnerId,
      status: o.status,
      purchaseAmountMicro: o.purchaseAmountMicroUsdc.toString(),
      purchaseTx: o.purchaseTx,
      proofHash: o.proofHash,
      occurredAt: iso(o.occurredAt),
      verifiedAt: iso(o.verifiedAt),
      holdUntil: iso(o.holdUntil),
      rejectionCode: o.rejectionCode,
      createdAt: o.createdAt.toISOString(),
    })),
    reservations: reservationRows.map((r) => ({
      id: r.id,
      campaignId: r.campaignId,
      outcomeId: r.outcomeId,
      amountMicro: r.amountMicroUsdc.toString(),
      state: r.state,
    })),
    payouts: payoutRows.map((p) => ({
      id: p.id,
      campaignId: p.campaignId,
      outcomeId: p.outcomeId,
      partnerId: p.partnerId,
      recipient: p.recipient,
      amountMicro: p.amountMicroUsdc.toString(),
      state: p.state,
      txHash: p.txHash,
      submittedAt: iso(p.submittedAt),
      settledAt: iso(p.settledAt),
      reconciledAt: iso(p.reconciledAt),
      failureCode: p.failureCode,
      createdAt: p.createdAt.toISOString(),
    })),
    activeCommitments: commitmentRows.map((c) => ({ campaignId: c.campaignId, amountMicro: c.amount.toString() })),
    activity: activityRows.map((a) => ({
      id: a.id,
      action: a.action,
      actorType: a.actorType,
      targetType: a.targetType,
      targetId: a.targetId,
      createdAt: a.createdAt.toISOString(),
    })),
    generatedAt: new Date().toISOString(),
  };
});

/** Resolves the session + current workspace snapshot, or null when the user has no workspace yet. */
export async function requireWorkspace() {
  const session = await getAppSession();
  if (session.kind !== "ok") return { session, snapshot: null };
  if (!session.current) return { session, snapshot: null };
  return { session, snapshot: await loadSnapshot(session.current.id) };
}
