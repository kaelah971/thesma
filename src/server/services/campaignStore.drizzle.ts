import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, type Db } from "../db/client";
import {
  auditEvents,
  campaignFundings,
  campaignPolicyVersions,
  campaigns,
  marketStates,
  partners,
  partnerTerms,
  privateInvites,
  referralEvents,
  referrals,
  workspaceMembers,
  workspaces,
} from "../db/schema";
import type { DbFunding, DbPolicyVersion } from "../db/schema";
import { newId } from "../auth/session";
import type {
  AuditSink,
  CampaignStore,
  FundingStore,
  MarketStore,
  NewCampaign,
  NewFunding,
  StoredFunding,
  StoredPolicyVersion,
  StoreMembership,
  StorePartner,
  StoreWorkspace,
} from "./campaignStore";
import { isUniqueViolation, uniqueViolation } from "./campaignStore";
import type { CampaignState } from "../domain/enums";

/** Drizzle infers jsonb columns as unknown; the domain contract is a record. */
function toStored(row: DbPolicyVersion): StoredPolicyVersion {
  return {
    ...row,
    allowedPartnerRulesJson: (row.allowedPartnerRulesJson ?? {}) as Record<string, unknown>,
    escalationRulesJson: (row.escalationRulesJson ?? {}) as Record<string, unknown>,
  };
}

/** Transaction handle from db.transaction(); supports the same queries as Db. */
export type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbLike = Db | DbTx;

function toFunding(row: DbFunding): StoredFunding {
  return row;
}

async function insertAuditEvent(db: DbLike, input: Parameters<AuditSink>[0]) {
  const [row] = await db
    .insert(auditEvents)
    .values({
      id: newId(),
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      workspaceId: input.workspaceId ?? null,
      partnerId: input.partnerId ?? null,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      metadata: input.metadata ?? {},
    })
    .returning();
  return row;
}

async function unique<T>(work: () => Promise<T>, message: string): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (isUniqueViolation(e)) throw uniqueViolation(message);
    throw e;
  }
}

/** Build a store over a Db or a transaction handle. */
function drizzleStoreFromDb(db: DbLike): MarketStore {
  const txAudit: AuditSink = (input) => insertAuditEvent(db, input);
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
    async insertVersion(v) {
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
    async atomic<T>(
      audit: AuditSink,
      work: (scoped: { store: FundingStore; audit: AuditSink }) => Promise<T>,
    ): Promise<T> {
      void audit; // the transaction-scoped sink below participates instead
      if ("transaction" in db && typeof (db as Db).transaction === "function") {
        return (db as Db).transaction(async (tx) => {
          const scoped = drizzleStoreFromDb(tx as DbTx);
          return work({ store: scoped, audit: txAudit });
        });
      }
      // Already inside a transaction: run directly with this handle's sink.
      return work({ store: drizzleStoreFromDb(db), audit: txAudit });
    },
    async getWorkspace(workspaceId): Promise<StoreWorkspace | null> {
      const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
      return row
        ? { id: row.id, ownerUserId: row.ownerUserId, companyWallet: row.companyWallet, category: row.category, name: row.name }
        : null;
    },
    async setCompanyWallet(workspaceId, address): Promise<StoreWorkspace> {
      const [row] = await db
        .update(workspaces)
        .set({ companyWallet: address, updatedAt: new Date() })
        .where(eq(workspaces.id, workspaceId))
        .returning();
      if (!row) throw new Error("Workspace not found");
      return { id: row.id, ownerUserId: row.ownerUserId, companyWallet: row.companyWallet, category: row.category, name: row.name };
    },
    async getFunding(campaignId, policyVersion) {
      const [row] = await db
        .select()
        .from(campaignFundings)
        .where(and(eq(campaignFundings.campaignId, campaignId), eq(campaignFundings.policyVersion, policyVersion)))
        .limit(1);
      return row ? toFunding(row) : null;
    },
    async insertFunding(f: NewFunding) {
      const [row] = await db.insert(campaignFundings).values({
        id: f.id,
        campaignId: f.campaignId,
        policyVersionId: f.policyVersionId,
        policyVersion: f.policyVersion,
        campaignKey: f.campaignKey,
        policyHash: f.policyHash,
        chainId: f.chainId,
        vaultAddress: f.vaultAddress,
        usdcAddress: f.usdcAddress,
        ownerAddress: f.ownerAddress,
        expectedAmountMicroUsdc: f.expectedAmountMicroUsdc,
      }).returning();
      return toFunding(row);
    },
    async updateFunding(campaignId, policyVersion, patch) {
      const [row] = await db
        .update(campaignFundings)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(campaignFundings.campaignId, campaignId), eq(campaignFundings.policyVersion, policyVersion)))
        .returning();
      if (!row) throw new Error("Funding not found");
      return toFunding(row);
    },
    async getPartnerByUserId(userId): Promise<StorePartner | null> {
      const [row] = await db.select().from(partners).where(eq(partners.userId, userId)).limit(1);
      return row
        ? {
            id: row.id,
            userId: row.userId,
            payoutWallet: row.payoutWallet,
            categories: [...row.categories],
            rulesJson: (row.rulesJson ?? {}) as Record<string, unknown>,
          }
        : null;
    },
    async updatePartnerRules(partnerId, rulesJson): Promise<StorePartner> {
      const [row] = await db
        .update(partners)
        .set({ rulesJson, updatedAt: new Date() })
        .where(eq(partners.id, partnerId))
        .returning();
      if (!row) throw new Error("Partner not found");
      return {
        id: row.id,
        userId: row.userId,
        payoutWallet: row.payoutWallet,
        categories: [...row.categories],
        rulesJson: (row.rulesJson ?? {}) as Record<string, unknown>,
      };
    },
    async getMarket(campaignId) {
      const [row] = await db.select().from(marketStates).where(eq(marketStates.campaignId, campaignId)).limit(1);
      return row ?? null;
    },
    async listMarkets() {
      return db.select().from(marketStates);
    },
    async insertMarket(m) {
      return unique(async () => {
        const [row] = await db.insert(marketStates).values({
          campaignId: m.campaignId,
          publicBountyMicroUsdc: m.publicBountyMicroUsdc,
          status: m.status,
          destinationUrl: m.destinationUrl,
          version: m.version,
          policyVersion: m.policyVersion,
        }).returning();
        return row;
      }, "Market already open");
    },
    async getTerms(campaignId, partnerId) {
      const [row] = await db
        .select()
        .from(partnerTerms)
        .where(and(eq(partnerTerms.campaignId, campaignId), eq(partnerTerms.partnerId, partnerId)))
        .limit(1);
      return row ?? null;
    },
    async listPartnerTerms(partnerId) {
      return db.select().from(partnerTerms).where(eq(partnerTerms.partnerId, partnerId));
    },
    async insertTerms(t) {
      return unique(async () => {
        const [row] = await db.insert(partnerTerms).values({
          id: t.id,
          campaignId: t.campaignId,
          partnerId: t.partnerId,
          priceMicroUsdc: t.priceMicroUsdc,
          allocationCount: t.allocationCount,
          source: t.source,
          expiresAt: t.expiresAt,
          policyVersion: t.policyVersion,
          marketVersion: t.marketVersion,
        }).returning();
        return row;
      }, "Partner terms already exist");
    },
    async lockPartnerRow(partnerId) {
      // Serializes a Partner's concurrent joins so the active-campaign cap
      // cannot be exceeded through a count-then-insert race.
      const rows = await db.select({ id: partners.id }).from(partners).where(eq(partners.id, partnerId)).for("update");
      if (rows.length === 0) throw new Error("Partner not found");
    },
    async insertReferral(r) {
      return unique(async () => {
        const [row] = await db.insert(referrals).values({
          id: r.id,
          code: r.code,
          campaignId: r.campaignId,
          partnerId: r.partnerId,
          partnerTermsId: r.partnerTermsId,
        }).returning();
        return row;
      }, "Referral code collision");
    },
    async getReferralByCode(code) {
      const [row] = await db.select().from(referrals).where(eq(referrals.code, code)).limit(1);
      return row ?? null;
    },
    async getReferralByTerms(partnerTermsId) {
      const [row] = await db.select().from(referrals).where(eq(referrals.partnerTermsId, partnerTermsId)).limit(1);
      return row ?? null;
    },
    async insertReferralEvent(e) {
      await db.insert(referralEvents).values({
        id: e.id,
        referralId: e.referralId,
        eventType: e.eventType,
        anonymousVisitorHash: e.anonymousVisitorHash,
        metadataJson: e.metadata,
      });
    },
    async insertInvite(i) {
      const [row] = await db.insert(privateInvites).values({
        id: i.id,
        campaignId: i.campaignId,
        tokenHash: i.tokenHash,
        expiresAt: i.expiresAt,
        maxUses: i.maxUses,
        createdByUserId: i.createdByUserId,
      }).returning();
      return row;
    },
    async getInviteByHash(tokenHash) {
      const [row] = await db.select().from(privateInvites).where(eq(privateInvites.tokenHash, tokenHash)).limit(1);
      return row ?? null;
    },
    async useInvite(tokenHash) {
      const [row] = await db
        .update(privateInvites)
        .set({ uses: sql`${privateInvites.uses} + 1` })
        .where(eq(privateInvites.tokenHash, tokenHash))
        .returning();
      if (!row) throw new Error("Invite not found");
      return row;
    },
  };
}

/**
 * Production FundingStore backed by Postgres/Drizzle.
 * Multi-write transitions run inside a DB transaction via atomic().
 */
export function createDrizzleCampaignStore(db: Db = getDb()): MarketStore {
  return drizzleStoreFromDb(db);
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
  return insertAuditEvent(getDb(), input);
}

export type { CampaignState };
