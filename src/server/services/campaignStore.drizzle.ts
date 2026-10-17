import { and, desc, eq } from "drizzle-orm";
import { getDb, type Db } from "../db/client";
import { campaignPolicyVersions, campaigns, workspaceMembers } from "../db/schema";
import type { DbPolicyVersion } from "../db/schema";
import type {
  CampaignStore,
  NewCampaign,
  NewPolicyVersion,
  StoredPolicyVersion,
  StoreMembership,
} from "./campaignStore";
import type { CampaignState } from "../domain/enums";

/** Drizzle infers jsonb columns as unknown; the domain contract is a record. */
function toStored(row: DbPolicyVersion): StoredPolicyVersion {
  return {
    ...row,
    allowedPartnerRulesJson: (row.allowedPartnerRulesJson ?? {}) as Record<string, unknown>,
    escalationRulesJson: (row.escalationRulesJson ?? {}) as Record<string, unknown>,
  };
}

/**
 * Production CampaignStore backed by Postgres/Drizzle.
 * Multi-write transitions run inside a transaction where needed.
 */
export function createDrizzleCampaignStore(db: Db = getDb()): CampaignStore {
  return {
    async getMembership(workspaceId, userId): Promise<StoreMembership | null> {
      const [row] = await db
        .select()
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
        .limit(1);
      return row ? { userId: row.userId, workspaceId: row.workspaceId, role: row.role } : null;
    },
    async getCampaign(campaignId) {
      const [row] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
      return row ?? null;
    },
    async listCampaigns(workspaceId) {
      return db.select().from(campaigns).where(eq(campaigns.workspaceId, workspaceId));
    },
    async insertCampaign(c: NewCampaign) {
      const [row] = await db.insert(campaigns).values({
        id: c.id,
        workspaceId: c.workspaceId,
        state: c.state,
        createdByUserId: c.createdByUserId,
      }).returning();
      return row;
    },
    async updateCampaign(id, patch) {
      const [row] = await db
        .update(campaigns)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(campaigns.id, id))
        .returning();
      if (!row) throw new Error("Campaign not found");
      return row;
    },
    async getVersion(campaignId, version) {
      const [row] = await db
        .select()
        .from(campaignPolicyVersions)
        .where(and(eq(campaignPolicyVersions.campaignId, campaignId), eq(campaignPolicyVersions.version, version)))
        .limit(1);
      return row ? toStored(row) : null;
    },
    async getCurrentVersion(campaignId) {
      const [row] = await db
        .select()
        .from(campaignPolicyVersions)
        .where(eq(campaignPolicyVersions.campaignId, campaignId))
        .orderBy(desc(campaignPolicyVersions.version))
        .limit(1);
      return row ? toStored(row) : null;
    },
    async insertVersion(v: NewPolicyVersion) {
      const [row] = await db.insert(campaignPolicyVersions).values({
        id: v.id,
        campaignId: v.campaignId,
        version: v.version,
        intentText: v.intentText,
        status: v.status,
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
      }).returning();
      return toStored(row);
    },
    async updateVersion(campaignId, version, patch) {
      const [row] = await db
        .update(campaignPolicyVersions)
        .set(patch)
        .where(
          and(eq(campaignPolicyVersions.campaignId, campaignId), eq(campaignPolicyVersions.version, version)),
        )
        .returning();
      if (!row) throw new Error("Policy version not found");
      return toStored(row);
    },
  };
}

/** Drizzle audit sink writing to audit_events. Not a financial receipt. */
export async function drizzleAuditSink(input: {
  actorType: "USER" | "SYSTEM" | "AGENT";
  actorId?: string | null;
  workspaceId?: string | null;
  partnerId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const { recordAuditEvent } = await import("./audit");
  return recordAuditEvent(getDb(), input);
}

export type { CampaignState };
