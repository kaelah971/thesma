import { and, count, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { getDb, type Db } from "../db/client";
import {
  attributionSessions,
  auditEvents,
  campaignFundings,
  campaignPolicyVersions,
  campaigns,
  checkoutIntents,
  marketDecisions,
  marketStates,
  negotiationDecisions,
  negotiations,
  supplyCommitments,
  outcomes,
  partners,
  partnerTerms,
  payouts,
  privateInvites,
  referralEvents,
  referrals,
  spendReservations,
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
    async getPartnerById(partnerId: string): Promise<StorePartner | null> {
      const [row] = await db.select().from(partners).where(eq(partners.id, partnerId)).limit(1);
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
    async updatePartnerWallet(partnerId: string, wallet: string | null): Promise<StorePartner> {
      const [row] = await db
        .update(partners)
        .set({ payoutWallet: wallet, updatedAt: new Date() })
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
    async updateMarket(campaignId, expectedVersion, patch) {
      const [row] = await db
        .update(marketStates)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(marketStates.campaignId, campaignId), eq(marketStates.version, expectedVersion)))
        .returning();
      if (!row) {
        throw Object.assign(new Error("Stale market version"), { status: 409, code: "STALE_MARKET" });
      }
      return row;
    },
    async insertNegotiation(n) {
      return unique(async () => {
        const [row] = await db.insert(negotiations).values({
          id: n.id,
          campaignId: n.campaignId,
          partnerId: n.partnerId,
          askMicroUsdc: n.askMicroUsdc,
          referenceBountyMicroUsdc: n.referenceBountyMicroUsdc,
          policyVersion: n.policyVersion,
          marketVersion: n.marketVersion,
          allocationCount: n.allocationCount,
          expiresAt: n.expiresAt,
        }).returning();
        return row;
      }, "An active negotiation already exists for this pair");
    },
    async getNegotiation(id) {
      const [row] = await db.select().from(negotiations).where(eq(negotiations.id, id)).limit(1);
      return row ?? null;
    },
    async getActiveNegotiation(campaignId, partnerId) {
      const [row] = await db
        .select()
        .from(negotiations)
        .where(
          and(
            eq(negotiations.campaignId, campaignId),
            eq(negotiations.partnerId, partnerId),
            sql`${negotiations.status} IN ('OPEN', 'COUNTERED', 'HOLD')`,
          ),
        )
        .limit(1);
      return row ?? null;
    },
    async updateNegotiation(id, patch) {
      return unique(async () => {
        const [row] = await db
          .update(negotiations)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(negotiations.id, id))
          .returning();
        if (!row) throw new Error("Negotiation not found");
        return row;
      }, "An active negotiation already exists for this pair");
    },
    async listActionableNegotiations(limit) {
      return db
        .select()
        .from(negotiations)
        .where(sql`${negotiations.status} IN ('OPEN', 'COUNTERED')`)
        .limit(limit);
    },
    async insertSupplyCommitment(c) {
      return unique(async () => {
        const [row] = await db.insert(supplyCommitments).values({
          id: c.id,
          campaignId: c.campaignId,
          negotiationId: c.negotiationId,
          partnerId: c.partnerId,
          partnerTermsId: c.partnerTermsId,
          amountMicroUsdc: c.amountMicroUsdc,
          expiresAt: c.expiresAt,
        }).returning();
        return row;
      }, "Commitment already exists for negotiation");
    },
    async getCommitmentByNegotiation(negotiationId) {
      const [row] = await db.select().from(supplyCommitments).where(eq(supplyCommitments.negotiationId, negotiationId)).limit(1);
      return row ?? null;
    },
    async getCommitmentByOutcome(outcomeId) {
      const [row] = await db.select().from(supplyCommitments).where(eq(supplyCommitments.consumedByOutcomeId, outcomeId)).limit(1);
      return row ?? null;
    },
    async getCommitmentByTerms(partnerTermsId) {
      const [row] = await db
        .select()
        .from(supplyCommitments)
        .where(and(eq(supplyCommitments.partnerTermsId, partnerTermsId), eq(supplyCommitments.state, "ACTIVE")))
        .limit(1);
      return row ?? null;
    },
    async listActiveCommitments(campaignId) {
      return db
        .select()
        .from(supplyCommitments)
        .where(and(eq(supplyCommitments.campaignId, campaignId), eq(supplyCommitments.state, "ACTIVE")));
    },
    async updateSupplyCommitment(id, patch) {
      const [row] = await db
        .update(supplyCommitments)
        .set({ ...patch, state: patch.state as "ACTIVE" | "CONSUMED" | "RELEASED" | "EXPIRED" | undefined, updatedAt: new Date() })
        .where(eq(supplyCommitments.id, id))
        .returning();
      if (!row) throw new Error("Commitment not found");
      return row;
    },
    async updateTermsStatus(termsId, status) {
      const [row] = await db
        .update(partnerTerms)
        .set({ status, updatedAt: new Date() })
        .where(eq(partnerTerms.id, termsId))
        .returning();
      if (!row) throw new Error("Terms not found");
      return row;
    },
    async insertNegotiationDecision(d) {
      return unique(async () => {
        const [row] = await db.insert(negotiationDecisions).values({
          id: d.id,
          negotiationId: d.negotiationId,
          round: d.round,
          decision: d.decision as "ACCEPT" | "COUNTER" | "REJECT" | "HOLD",
          reasonCodes: d.reasonCodes,
          inputsJson: d.inputsJson,
          inputsHash: d.inputsHash,
          askMicroUsdc: d.askMicroUsdc,
          counterMicroUsdc: d.counterMicroUsdc,
          autoExecuted: d.autoExecuted ? 1 : 0,
        }).returning();
        return {
          ...row,
          autoExecuted: row.autoExecuted === 1,
          inputsJson: (row.inputsJson ?? {}) as Record<string, unknown>,
        };
      }, "Negotiation decision already recorded");
    },
    async getLatestNegotiationDecision(negotiationId) {
      const [row] = await db
        .select()
        .from(negotiationDecisions)
        .where(eq(negotiationDecisions.negotiationId, negotiationId))
        .orderBy(desc(negotiationDecisions.createdAt))
        .limit(1);
      return row
        ? {
            ...row,
            autoExecuted: row.autoExecuted === 1,
            inputsJson: (row.inputsJson ?? {}) as Record<string, unknown>,
          }
        : null;
    },
    async insertPricingDecision(d) {
      return unique(async () => {
        const [row] = await db.insert(marketDecisions).values({
          id: d.id,
          campaignId: d.campaignId,
          marketVersion: d.marketVersion,
          decision: d.decision as "KEEP" | "REPRICE" | "PAUSE",
          paceState: d.paceState,
          reasonCodes: d.reasonCodes,
          inputsJson: d.inputsJson,
          inputsHash: d.inputsHash,
          oldBountyMicroUsdc: d.oldBountyMicroUsdc,
          newBountyMicroUsdc: d.newBountyMicroUsdc,
          autoExecuted: d.autoExecuted ? 1 : 0,
        }).returning();
        return {
          ...row,
          autoExecuted: row.autoExecuted === 1,
          inputsJson: (row.inputsJson ?? {}) as Record<string, unknown>,
        };
      }, "Pricing decision already recorded for this state");
    },
    async getLatestPricingDecision(campaignId) {
      const [row] = await db
        .select()
        .from(marketDecisions)
        .where(eq(marketDecisions.campaignId, campaignId))
        .orderBy(desc(marketDecisions.createdAt))
        .limit(1);
      return row
        ? {
            ...row,
            autoExecuted: row.autoExecuted === 1,
            inputsJson: (row.inputsJson ?? {}) as Record<string, unknown>,
          }
        : null;
    },
    async getLastExecutedRepriceAt(campaignId) {
      const [row] = await db
        .select()
        .from(marketDecisions)
        .where(and(eq(marketDecisions.campaignId, campaignId), eq(marketDecisions.decision, "REPRICE")))
        .orderBy(desc(marketDecisions.createdAt))
        .limit(1);
      return row && row.autoExecuted === 1 ? row.createdAt : null;
    },
    async countTermsSince(campaignId, since) {
      const [row] = await db
        .select({ n: count() })
        .from(partnerTerms)
        .where(and(eq(partnerTerms.campaignId, campaignId), gte(partnerTerms.createdAt, since)));
      return row?.n ?? 0;
    },
    async countVerifiedOutcomesSince(campaignId, since) {
      const [row] = await db
        .select({ n: count() })
        .from(outcomes)
        .where(
          and(eq(outcomes.campaignId, campaignId), eq(outcomes.status, "VERIFIED"), gte(outcomes.verifiedAt, since)),
        );
      return row?.n ?? 0;
    },
    async countVerifiedOutcomes(campaignId) {
      const [row] = await db
        .select({ n: count() })
        .from(outcomes)
        .where(and(eq(outcomes.campaignId, campaignId), eq(outcomes.status, "VERIFIED")));
      return row?.n ?? 0;
    },
    async insertAttributionSession(s) {
      return unique(async () => {
        const [row] = await db.insert(attributionSessions).values({
          id: s.id,
          referralId: s.referralId,
          campaignId: s.campaignId,
          partnerId: s.partnerId,
          partnerTermsId: s.partnerTermsId,
          expiresAt: s.expiresAt,
        }).returning();
        return row;
      }, "Attribution session exists");
    },
    async getAttributionSession(id) {
      const [row] = await db.select().from(attributionSessions).where(eq(attributionSessions.id, id)).limit(1);
      return row ?? null;
    },
    async consumeAttributionSession(id) {
      // Single conditional write: only an unused session flips to used.
      const [row] = await db
        .update(attributionSessions)
        .set({ usedAt: new Date() })
        .where(and(eq(attributionSessions.id, id), isNull(attributionSessions.usedAt)))
        .returning();
      return row ?? null;
    },
    async insertCheckoutIntent(i) {
      return unique(async () => {
        const [row] = await db.insert(checkoutIntents).values({
          id: i.id,
          orderId: i.orderId,
          campaignId: i.campaignId,
          policyVersionId: i.policyVersionId,
          partnerId: i.partnerId,
          partnerTermsId: i.partnerTermsId,
          attributionSessionId: i.attributionSessionId,
          payerAddress: i.payerAddress,
          merchantAddress: i.merchantAddress,
          amountMicroUsdc: i.amountMicroUsdc,
          chainId: i.chainId,
          usdcAddress: i.usdcAddress,
          expiresAt: i.expiresAt,
        }).returning();
        return row;
      }, "Order ID collision");
    },
    async getCheckoutIntent(id) {
      const [row] = await db.select().from(checkoutIntents).where(eq(checkoutIntents.id, id)).limit(1);
      return row ?? null;
    },
    async updateCheckoutIntent(id, patch) {
      return unique(async () => {
        const [row] = await db
          .update(checkoutIntents)
          .set({ ...patch, status: patch.status as "PREPARED" | "SUBMITTED" | "CONFIRMED" | "REJECTED" | "AMBIGUOUS" | undefined, updatedAt: new Date() })
          .where(eq(checkoutIntents.id, id))
          .returning();
        if (!row) throw new Error("Checkout intent not found");
        return row;
      }, "Transaction hash already submitted");
    },
    async insertOutcome(o) {
      return unique(async () => {
        const [row] = await db.insert(outcomes).values({
          id: o.id,
          campaignId: o.campaignId,
          partnerId: o.partnerId,
          partnerTermsId: o.partnerTermsId,
          checkoutIntentId: o.checkoutIntentId,
          customerKeyHash: o.customerKeyHash,
          purchaseTx: o.purchaseTx,
          purchaseAmountMicroUsdc: o.purchaseAmountMicroUsdc,
        }).returning();
        return row;
      }, "Outcome already exists");
    },
    async getOutcome(id) {
      const [row] = await db.select().from(outcomes).where(eq(outcomes.id, id)).limit(1);
      return row ?? null;
    },
    async getOutcomeByIntent(checkoutIntentId) {
      const [row] = await db.select().from(outcomes).where(eq(outcomes.checkoutIntentId, checkoutIntentId)).limit(1);
      return row ?? null;
    },
    async getOutcomeByTx(purchaseTx) {
      const [row] = await db.select().from(outcomes).where(eq(outcomes.purchaseTx, purchaseTx)).limit(1);
      return row ?? null;
    },
    async getOutcomeByCustomer(campaignId, customerKeyHash) {
      const [row] = await db
        .select()
        .from(outcomes)
        .where(and(eq(outcomes.campaignId, campaignId), eq(outcomes.customerKeyHash, customerKeyHash)))
        .limit(1);
      return row ?? null;
    },
    async updateOutcome(id, patch) {
      return unique(async () => {
        const [row] = await db
          .update(outcomes)
          .set({ ...patch, status: patch.status as "PENDING" | "VERIFIED" | "REJECTED" | undefined, updatedAt: new Date() })
          .where(eq(outcomes.id, id))
          .returning();
        if (!row) throw new Error("Outcome not found");
        return row;
      }, "Outcome uniqueness conflict");
    },
    async listOutcomesByStatus(status, limit) {
      return db
        .select()
        .from(outcomes)
        .where(eq(outcomes.status, status as "PENDING" | "VERIFIED" | "REJECTED"))
        .limit(limit);
    },
    async insertReservation(r) {
      return unique(async () => {
        const [row] = await db.insert(spendReservations).values({
          id: r.id,
          campaignId: r.campaignId,
          outcomeId: r.outcomeId,
          partnerId: r.partnerId,
          partnerTermsId: r.partnerTermsId,
          amountMicroUsdc: r.amountMicroUsdc,
          policyVersionId: r.policyVersionId,
        }).returning();
        return row;
      }, "Reservation already exists for outcome");
    },
    async getReservation(id) {
      const [row] = await db.select().from(spendReservations).where(eq(spendReservations.id, id)).limit(1);
      return row ?? null;
    },
    async getReservationByOutcome(outcomeId) {
      const [row] = await db.select().from(spendReservations).where(eq(spendReservations.outcomeId, outcomeId)).limit(1);
      return row ?? null;
    },
    async listReservationsByCampaign(campaignId) {
      return db.select().from(spendReservations).where(eq(spendReservations.campaignId, campaignId));
    },
    async updateReservation(id, patch) {
      const [row] = await db
        .update(spendReservations)
        .set({ ...patch, state: patch.state as "RESERVED" | "SUBMITTED" | "SETTLED" | "FAILED" | "AMBIGUOUS" | "RELEASED" | undefined, updatedAt: new Date() })
        .where(eq(spendReservations.id, id))
        .returning();
      if (!row) throw new Error("Reservation not found");
      return row;
    },
    async insertPayout(p) {
      return unique(async () => {
        const [row] = await db.insert(payouts).values({
          id: p.id,
          reservationId: p.reservationId,
          outcomeId: p.outcomeId,
          campaignId: p.campaignId,
          partnerId: p.partnerId,
          recipient: p.recipient,
          amountMicroUsdc: p.amountMicroUsdc,
          proofHash: p.proofHash,
        }).returning();
        return row;
      }, "Payout already exists");
    },
    async getPayout(id) {
      const [row] = await db.select().from(payouts).where(eq(payouts.id, id)).limit(1);
      return row ?? null;
    },
    async getPayoutByOutcome(outcomeId) {
      const [row] = await db.select().from(payouts).where(eq(payouts.outcomeId, outcomeId)).limit(1);
      return row ?? null;
    },
    async getPayoutByReservation(reservationId) {
      const [row] = await db.select().from(payouts).where(eq(payouts.reservationId, reservationId)).limit(1);
      return row ?? null;
    },
    async updatePayout(id, patch) {
      return unique(async () => {
        const [row] = await db
          .update(payouts)
          .set({ ...patch, state: patch.state as "PREPARED" | "SUBMITTED" | "SETTLED" | "FAILED" | "AMBIGUOUS" | undefined, updatedAt: new Date() })
          .where(eq(payouts.id, id))
          .returning();
        if (!row) throw new Error("Payout not found");
        return row;
      }, "Payout uniqueness conflict");
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
