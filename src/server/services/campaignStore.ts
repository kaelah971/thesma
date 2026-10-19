import type { CampaignState, MarketState, WorkspaceRole } from "../domain/enums";
import type { Campaign, CampaignPolicyFields, CampaignPolicyVersion, PolicyVersionStatus } from "../domain/campaign";

/**
 * Persistence boundary for S1 campaigns. Services depend on this interface,
 * not on Drizzle — unit tests run against the in-memory implementation with
 * no Postgres. Routes wire the Drizzle implementation (`campaignStore.drizzle`).
 */

export interface StoreMembership {
  userId: string;
  workspaceId: string;
  role: WorkspaceRole;
}

export interface StoreWorkspace {
  id: string;
  ownerUserId: string;
  companyWallet: string | null;
  category: string | null;
  name: string;
}

export interface StorePartner {
  id: string;
  userId: string;
  payoutWallet: string | null;
  categories: string[];
  rulesJson: Record<string, unknown>;
}

export interface StoredMarket {
  campaignId: string;
  publicBountyMicroUsdc: bigint;
  status: MarketState;
  destinationUrl: string;
  version: number;
  policyVersion: number;
  openedAt: Date;
  updatedAt: Date;
}

export interface NewMarket {
  campaignId: string;
  publicBountyMicroUsdc: bigint;
  status: MarketState;
  destinationUrl: string;
  version: number;
  policyVersion: number;
}

export interface StoredTerms {
  id: string;
  campaignId: string;
  partnerId: string;
  priceMicroUsdc: bigint;
  allocationCount: number;
  source: string;
  expiresAt: Date;
  policyVersion: number;
  marketVersion: number;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewTerms {
  id: string;
  campaignId: string;
  partnerId: string;
  priceMicroUsdc: bigint;
  allocationCount: number;
  source: string;
  expiresAt: Date;
  policyVersion: number;
  marketVersion: number;
}

export interface StoredReferral {
  id: string;
  code: string;
  campaignId: string;
  partnerId: string;
  partnerTermsId: string;
  status: string;
  createdAt: Date;
}

export interface StoredInvite {
  id: string;
  campaignId: string;
  tokenHash: string;
  expiresAt: Date;
  maxUses: number | null;
  uses: number;
  createdByUserId: string;
  createdAt: Date;
}

export type InvitationStatus = "INVITED" | "ACCEPTED" | "DECLINED" | "CANCELLED";

export interface StoredInvitation {
  id: string;
  campaignId: string;
  organizationUserId: string;
  creatorUserId: string;
  status: InvitationStatus;
  offeredOutcomeKind: string;
  offeredBountyMicroUsdc: bigint;
  offeredMinQualifyingMicroUsdc: bigint | null;
  offeredHoldSeconds: number | null;
  offeredPolicyVersion: number;
  offeredMarketVersion: number;
  offeredBonusJson: Record<string, unknown>;
  matchScore: number;
  matchConfidence: string;
  matchAction: string;
  matchReasons: string[];
  respondedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewInvitation {
  id: string;
  campaignId: string;
  organizationUserId: string;
  creatorUserId: string;
  offeredOutcomeKind: string;
  offeredBountyMicroUsdc: bigint;
  offeredMinQualifyingMicroUsdc: bigint | null;
  offeredHoldSeconds: number | null;
  offeredPolicyVersion: number;
  offeredMarketVersion: number;
  offeredBonusJson?: Record<string, unknown>;
  matchScore: number;
  matchConfidence: string;
  matchAction: string;
  matchReasons: string[];
}

export interface StoredNegotiation {
  id: string;
  campaignId: string;
  partnerId: string;
  round: number;
  status: string;
  askMicroUsdc: bigint;
  referenceBountyMicroUsdc: bigint;
  counterMicroUsdc: bigint | null;
  policyVersion: number;
  marketVersion: number;
  allocationCount: number;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface StoredSupplyCommitment {
  id: string;
  campaignId: string;
  negotiationId: string;
  partnerId: string;
  partnerTermsId: string;
  amountMicroUsdc: bigint;
  state: string;
  consumedByOutcomeId: string | null;
  consumedByReservationId: string | null;
  releasedReason: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface StoredNegotiationDecision {
  id: string;
  negotiationId: string;
  round: number;
  decision: string;
  reasonCodes: string[];
  inputsJson: Record<string, unknown>;
  inputsHash: string;
  askMicroUsdc: bigint;
  counterMicroUsdc: bigint | null;
  autoExecuted: boolean;
  createdAt: Date;
}

export interface StoredPricingDecision {
  id: string;
  campaignId: string;
  marketVersion: number;
  decision: string;
  paceState: string;
  reasonCodes: string[];
  inputsJson: Record<string, unknown>;
  inputsHash: string;
  oldBountyMicroUsdc: bigint | null;
  newBountyMicroUsdc: bigint | null;
  autoExecuted: boolean;
  createdAt: Date;
}

export interface NewPricingDecision {
  id: string;
  campaignId: string;
  marketVersion: number;
  decision: string;
  paceState: string;
  reasonCodes: string[];
  inputsJson: Record<string, unknown>;
  inputsHash: string;
  oldBountyMicroUsdc: bigint | null;
  newBountyMicroUsdc: bigint | null;
  autoExecuted: boolean;
}

export interface NewReferralEvent {
  id: string;
  referralId: string;
  eventType: string;
  anonymousVisitorHash: string | null;
  metadata: Record<string, unknown> | null;
}

export interface StoredAttributionSession {
  id: string;
  referralId: string;
  campaignId: string;
  partnerId: string;
  partnerTermsId: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

export interface StoredCheckoutIntent {
  id: string;
  orderId: string;
  campaignId: string;
  policyVersionId: string;
  partnerId: string;
  partnerTermsId: string;
  attributionSessionId: string | null;
  payerAddress: string;
  merchantAddress: string;
  amountMicroUsdc: bigint;
  chainId: number;
  usdcAddress: string;
  status: string;
  txHash: string | null;
  expiresAt: Date;
  submittedAt: Date | null;
  confirmedAt: Date | null;
  failureCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewCheckoutIntent {
  id: string;
  orderId: string;
  campaignId: string;
  policyVersionId: string;
  partnerId: string;
  partnerTermsId: string;
  attributionSessionId: string | null;
  payerAddress: string;
  merchantAddress: string;
  amountMicroUsdc: bigint;
  chainId: number;
  usdcAddress: string;
  expiresAt: Date;
}

export interface StoredOutcome {
  id: string;
  campaignId: string;
  partnerId: string;
  partnerTermsId: string;
  checkoutIntentId: string;
  customerKeyHash: string;
  purchaseTx: string;
  purchaseAmountMicroUsdc: bigint;
  status: string;
  proofHash: string | null;
  blockNumber: number | null;
  occurredAt: Date | null;
  verifiedAt: Date | null;
  holdUntil: Date | null;
  rejectionCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StoredReservation {
  id: string;
  campaignId: string;
  outcomeId: string;
  partnerId: string;
  partnerTermsId: string;
  amountMicroUsdc: bigint;
  policyVersionId: string;
  state: string;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StoredPayout {
  id: string;
  reservationId: string;
  outcomeId: string;
  campaignId: string;
  partnerId: string;
  recipient: string;
  amountMicroUsdc: bigint;
  proofHash: string;
  verifierSignature: string | null;
  txHash: string | null;
  state: string;
  blockNumber: number | null;
  submittedAt: Date | null;
  settledAt: Date | null;
  reconciledAt: Date | null;
  failureCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Thrown (or translated from PG 23505) when a uniqueness race loses. Services retry or 409. */
export function uniqueViolation(message: string) {
  return Object.assign(new Error(message), { code: "UNIQUE_VIOLATION", status: 409 });
}

export function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === "UNIQUE_VIOLATION" || code === "23505") return true;
  const msg = (e as { message?: unknown } | null)?.message;
  return typeof msg === "string" && /duplicate key value/i.test(msg);
}

export const FUNDING_STATUSES = ["PREPARED", "SUBMITTED", "CONFIRMED", "FAILED", "AMBIGUOUS"] as const;
export type FundingStatus = (typeof FUNDING_STATUSES)[number];

export interface StoredFunding {
  id: string;
  campaignId: string;
  policyVersionId: string;
  policyVersion: number;
  campaignKey: string;
  policyHash: string;
  chainId: number;
  vaultAddress: string;
  usdcAddress: string;
  ownerAddress: string;
  expectedAmountMicroUsdc: bigint;
  status: FundingStatus;
  createTxHash: string | null;
  approveTxHash: string | null;
  fundingTxHash: string | null;
  blockNumber: number | null;
  observedAmountMicroUsdc: bigint | null;
  failureCode: string | null;
  submittedAt: Date | null;
  confirmedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewFunding {
  id: string;
  campaignId: string;
  policyVersionId: string;
  policyVersion: number;
  campaignKey: string;
  policyHash: string;
  chainId: number;
  vaultAddress: string;
  usdcAddress: string;
  ownerAddress: string;
  expectedAmountMicroUsdc: bigint;
}

export interface StoredCampaign extends Campaign {}
export interface StoredPolicyVersion extends CampaignPolicyVersion {}

export interface NewCampaign {
  id: string;
  workspaceId: string;
  state: CampaignState;
  createdByUserId: string;
}

export interface NewPolicyVersion extends CampaignPolicyFields {
  id: string;
  campaignId: string;
  version: number;
  intentText: string;
  status: PolicyVersionStatus;
}

export interface CampaignStore {
  getMembership(workspaceId: string, userId: string): Promise<StoreMembership | null>;
  getCampaign(campaignId: string): Promise<StoredCampaign | null>;
  listCampaigns(workspaceId: string): Promise<StoredCampaign[]>;
  insertCampaign(c: NewCampaign): Promise<StoredCampaign>;
  updateCampaign(id: string, patch: { state?: CampaignState; currentPolicyVersionId?: string | null }): Promise<StoredCampaign>;
  getVersion(campaignId: string, version: number): Promise<StoredPolicyVersion | null>;
  getCurrentVersion(campaignId: string): Promise<StoredPolicyVersion | null>;
  insertVersion(v: NewPolicyVersion): Promise<StoredPolicyVersion>;
  /** Only ever called on non-APPROVED rows (enforced by the service). */
  updateVersion(
    campaignId: string,
    version: number,
    patch: Partial<CampaignPolicyFields> & { status?: PolicyVersionStatus; approvedByUserId?: string | null; approvedAt?: Date | null },
  ): Promise<StoredPolicyVersion>;
  /** Run work atomically: Drizzle uses a DB transaction; memory snapshots and restores on failure. */
  atomic<T>(
    audit: AuditSink,
    work: (scoped: { store: FundingStore; audit: AuditSink }) => Promise<T>,
  ): Promise<T>;
  getWorkspace(workspaceId: string): Promise<StoreWorkspace | null>;
  setCompanyWallet(workspaceId: string, address: string): Promise<StoreWorkspace>;
}

/** Market persistence: markets, terms snapshots, referrals, clicks, invites. */
export interface MarketStore extends FundingStore {
  getPartnerByUserId(userId: string): Promise<StorePartner | null>;
  getPartnerById(partnerId: string): Promise<StorePartner | null>;
  /** Partners whose stored rules enable autoJoin. Rules still re-validated per run. */
  listAutoJoinPartners(): Promise<StorePartner[]>;
  updatePartnerRules(partnerId: string, rulesJson: Record<string, unknown>): Promise<StorePartner>;
  getMarket(campaignId: string): Promise<StoredMarket | null>;
  listMarkets(): Promise<StoredMarket[]>;
  insertMarket(m: NewMarket): Promise<StoredMarket>;
  getTerms(campaignId: string, partnerId: string): Promise<StoredTerms | null>;
  listPartnerTerms(partnerId: string): Promise<StoredTerms[]>;
  insertTerms(t: NewTerms): Promise<StoredTerms>;
  /** Row-level lock (SELECT FOR UPDATE) serializing a Partner's concurrent joins. */
  lockPartnerRow(partnerId: string): Promise<void>;
  insertReferral(r: { id: string; code: string; campaignId: string; partnerId: string; partnerTermsId: string }): Promise<StoredReferral>;
  getReferralByCode(code: string): Promise<StoredReferral | null>;
  getReferralByTerms(partnerTermsId: string): Promise<StoredReferral | null>;
  insertReferralEvent(e: NewReferralEvent): Promise<void>;
  insertInvite(i: { id: string; campaignId: string; tokenHash: string; expiresAt: Date; maxUses: number | null; createdByUserId: string }): Promise<StoredInvite>;
  getInviteByHash(tokenHash: string): Promise<StoredInvite | null>;
  useInvite(tokenHash: string): Promise<StoredInvite>;
  insertInvitation(i: NewInvitation): Promise<StoredInvitation>;
  getInvitation(id: string): Promise<StoredInvitation | null>;
  findActiveInvitation(campaignId: string, creatorUserId: string): Promise<StoredInvitation | null>;
  listInvitationsByCampaign(campaignId: string): Promise<StoredInvitation[]>;
  listInvitationsByCreator(creatorUserId: string): Promise<StoredInvitation[]>;
  updateInvitationStatus(id: string, status: "CANCELLED" | "ACCEPTED" | "DECLINED"): Promise<StoredInvitation>;
  /** Optimistic market mutation; throws STALE (409) on version mismatch. */
  updateMarket(
    campaignId: string,
    expectedVersion: number,
    patch: Partial<Pick<StoredMarket, "publicBountyMicroUsdc" | "status">> & { version: number },
  ): Promise<StoredMarket>;
  insertNegotiation(n: {
    id: string; campaignId: string; partnerId: string; askMicroUsdc: bigint;
    referenceBountyMicroUsdc: bigint; policyVersion: number; marketVersion: number;
    allocationCount: number; expiresAt: Date;
  }): Promise<StoredNegotiation>;
  getNegotiation(id: string): Promise<StoredNegotiation | null>;
  /** The single non-terminal row per pair, if any. */
  getActiveNegotiation(campaignId: string, partnerId: string): Promise<StoredNegotiation | null>;
  updateNegotiation(
    id: string,
    patch: Partial<Pick<StoredNegotiation, "round" | "status" | "askMicroUsdc" | "referenceBountyMicroUsdc" | "counterMicroUsdc" | "marketVersion" | "expiresAt">>,
  ): Promise<StoredNegotiation>;
  /** OPEN + COUNTERED rows for the worker sweep. */
  listActionableNegotiations(limit: number): Promise<StoredNegotiation[]>;
  insertSupplyCommitment(c: {
    id: string; campaignId: string; negotiationId: string; partnerId: string;
    partnerTermsId: string; amountMicroUsdc: bigint; expiresAt: Date;
  }): Promise<StoredSupplyCommitment>;
  getCommitmentByNegotiation(negotiationId: string): Promise<StoredSupplyCommitment | null>;
  getCommitmentByOutcome(outcomeId: string): Promise<StoredSupplyCommitment | null>;
  getCommitmentByTerms(partnerTermsId: string): Promise<StoredSupplyCommitment | null>;
  listActiveCommitments(campaignId: string): Promise<StoredSupplyCommitment[]>;
  updateSupplyCommitment(
    id: string,
    patch: Partial<Pick<StoredSupplyCommitment, "state" | "consumedByOutcomeId" | "consumedByReservationId" | "releasedReason">>,
  ): Promise<StoredSupplyCommitment>;
  updateTermsStatus(termsId: string, status: string): Promise<StoredTerms>;
  insertNegotiationDecision(d: {
    id: string; negotiationId: string; round: number; decision: string; reasonCodes: string[];
    inputsJson: Record<string, unknown>; inputsHash: string;
    askMicroUsdc: bigint; counterMicroUsdc: bigint | null; autoExecuted: boolean;
  }): Promise<StoredNegotiationDecision>;
  getLatestNegotiationDecision(negotiationId: string): Promise<StoredNegotiationDecision | null>;
  insertPricingDecision(d: NewPricingDecision): Promise<StoredPricingDecision>;
  getLatestPricingDecision(campaignId: string): Promise<StoredPricingDecision | null>;
  getLastExecutedRepriceAt(campaignId: string): Promise<Date | null>;
  countTermsSince(campaignId: string, since: Date): Promise<number>;
  countVerifiedOutcomesSince(campaignId: string, since: Date): Promise<number>;
  countVerifiedOutcomes(campaignId: string): Promise<number>;
  insertAttributionSession(s: { id: string; referralId: string; campaignId: string; partnerId: string; partnerTermsId: string; expiresAt: Date }): Promise<StoredAttributionSession>;
  getAttributionSession(id: string): Promise<StoredAttributionSession | null>;
  /** Single-use consume: null when missing or already used (race-safe). */
  consumeAttributionSession(id: string): Promise<StoredAttributionSession | null>;
  insertCheckoutIntent(i: NewCheckoutIntent): Promise<StoredCheckoutIntent>;
  getCheckoutIntent(id: string): Promise<StoredCheckoutIntent | null>;
  updateCheckoutIntent(
    id: string,
    patch: Partial<Pick<StoredCheckoutIntent, "status" | "txHash" | "submittedAt" | "confirmedAt" | "failureCode">>,
  ): Promise<StoredCheckoutIntent>;
  insertOutcome(o: {
    id: string; campaignId: string; partnerId: string; partnerTermsId: string; checkoutIntentId: string;
    customerKeyHash: string; purchaseTx: string; purchaseAmountMicroUsdc: bigint;
  }): Promise<StoredOutcome>;
  getOutcome(id: string): Promise<StoredOutcome | null>;
  getOutcomeByIntent(checkoutIntentId: string): Promise<StoredOutcome | null>;
  getOutcomeByTx(purchaseTx: string): Promise<StoredOutcome | null>;
  getOutcomeByCustomer(campaignId: string, customerKeyHash: string): Promise<StoredOutcome | null>;
  listOutcomesByStatus(status: string, limit: number): Promise<StoredOutcome[]>;
  updatePartnerWallet(partnerId: string, wallet: string | null): Promise<StorePartner>;
  insertReservation(r: {
    id: string; campaignId: string; outcomeId: string; partnerId: string; partnerTermsId: string;
    amountMicroUsdc: bigint; policyVersionId: string;
  }): Promise<StoredReservation>;
  getReservation(id: string): Promise<StoredReservation | null>;
  getReservationByOutcome(outcomeId: string): Promise<StoredReservation | null>;
  listReservationsByCampaign(campaignId: string): Promise<StoredReservation[]>;
  updateReservation(
    id: string,
    patch: Partial<Pick<StoredReservation, "state" | "expiresAt">>,
  ): Promise<StoredReservation>;
  insertPayout(p: {
    id: string; reservationId: string; outcomeId: string; campaignId: string; partnerId: string;
    recipient: string; amountMicroUsdc: bigint; proofHash: string;
  }): Promise<StoredPayout>;
  getPayout(id: string): Promise<StoredPayout | null>;
  getPayoutByOutcome(outcomeId: string): Promise<StoredPayout | null>;
  getPayoutByReservation(reservationId: string): Promise<StoredPayout | null>;
  updatePayout(
    id: string,
    patch: Partial<Pick<StoredPayout, "state" | "recipient" | "amountMicroUsdc" | "proofHash" | "verifierSignature" | "txHash" | "blockNumber" | "submittedAt" | "settledAt" | "reconciledAt" | "failureCode">>,
  ): Promise<StoredPayout>;
  updateOutcome(
    id: string,
    patch: Partial<Pick<StoredOutcome, "status" | "purchaseTx" | "purchaseAmountMicroUsdc" | "customerKeyHash" | "proofHash" | "blockNumber" | "occurredAt" | "verifiedAt" | "holdUntil" | "rejectionCode">>,
  ): Promise<StoredOutcome>;
}

/** Funding persistence. One record per (campaignId, policyVersion). */
export interface FundingStore extends CampaignStore {
  getFunding(campaignId: string, policyVersion: number): Promise<StoredFunding | null>;
  insertFunding(f: NewFunding): Promise<StoredFunding>;
  updateFunding(
    campaignId: string,
    policyVersion: number,
    patch: Partial<Pick<StoredFunding, "status" | "campaignKey" | "createTxHash" | "approveTxHash" | "fundingTxHash" | "blockNumber" | "observedAmountMicroUsdc" | "failureCode" | "submittedAt" | "confirmedAt">>,
  ): Promise<StoredFunding>;
}

export type AuditSink = (input: {
  actorType: "USER" | "SYSTEM" | "AGENT";
  actorId?: string | null;
  workspaceId?: string | null;
  partnerId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}) => Promise<unknown>;

/** Deterministic in-memory store for tests. Single-threaded: no races. */
export function createMemoryCampaignStore(seed?: {
  memberships?: StoreMembership[];
  workspaces?: Array<{ id: string; ownerUserId?: string; companyWallet?: string | null; category?: string | null; name?: string }>;
  partners?: Array<{ id: string; userId: string; payoutWallet?: string | null; categories?: string[]; rulesJson?: Record<string, unknown> }>;
}): MarketStore & { campaigns: Map<string, StoredCampaign>; versions: Map<string, StoredPolicyVersion[]> } {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const campaigns = new Map<string, StoredCampaign>();
  const versions = new Map<string, StoredPolicyVersion[]>();
  const memberships = new Map<string, StoreMembership>();
  const workspaceRows = new Map<string, StoreWorkspace>();
  const fundings = new Map<string, StoredFunding>();
  const partnerRows = new Map<string, StorePartner>();
  const partnerByUser = new Map<string, string>();
  const marketStates = new Map<string, StoredMarket>();
  const termsRows = new Map<string, StoredTerms>();
  const termsByPair = new Map<string, string>();
  const referrals = new Map<string, StoredReferral>();
  const referralsByCode = new Map<string, string>();
  const referralEvents: Array<NewReferralEvent & { occurredAt: Date }> = [];
  const invites = new Map<string, StoredInvite>();
  const invitations = new Map<string, StoredInvitation>();
  const decisions: StoredPricingDecision[] = [];
  const decisionKeys = new Set<string>();
  const negotiations = new Map<string, StoredNegotiation>();
  const negotiationDecisions: StoredNegotiationDecision[] = [];
  const supplyCommitments = new Map<string, StoredSupplyCommitment>();
  const negotiationDecisionKeys = new Set<string>();
  const attrSessions = new Map<string, StoredAttributionSession>();
  const intents = new Map<string, StoredCheckoutIntent>();
  const intentsByOrder = new Map<string, string>();
  const outcomes = new Map<string, StoredOutcome>();
  const outcomesByIntent = new Map<string, string>();
  const outcomesByTx = new Map<string, string>();
  const reservations = new Map<string, StoredReservation>();
  const reservationsByOutcome = new Map<string, string>();
  const payouts = new Map<string, StoredPayout>();
  const payoutsByOutcome = new Map<string, string>();
  const payoutsByReservation = new Map<string, string>();
  for (const m of seed?.memberships ?? []) memberships.set(`${m.workspaceId}:${m.userId}`, m);
  for (const w of seed?.workspaces ?? []) {
    workspaceRows.set(w.id, {
      id: w.id,
      ownerUserId: w.ownerUserId ?? "",
      companyWallet: w.companyWallet ?? null,
      category: w.category ?? null,
      name: w.name ?? "Workspace",
    });
  }
  // Membership implies a workspace row unless one was seeded explicitly.
  for (const m of seed?.memberships ?? []) {
    if (!workspaceRows.has(m.workspaceId)) {
      workspaceRows.set(m.workspaceId, { id: m.workspaceId, ownerUserId: m.userId, companyWallet: null, category: null, name: "Workspace" });
    }
  }
  for (const p of seed?.partners ?? []) {
    partnerRows.set(p.id, { categories: [], rulesJson: {}, payoutWallet: null, ...p });
    partnerByUser.set(p.userId, p.id);
  }

  const current = (campaignId: string): StoredPolicyVersion | null => {
    const list = versions.get(campaignId) ?? [];
    return list.length === 0 ? null : list[list.length - 1];
  };

  const self: MarketStore & {
    campaigns: Map<string, StoredCampaign>;
    versions: Map<string, StoredPolicyVersion[]>;
  } = {
    campaigns,
    versions,
    async getMembership(workspaceId, userId) {
      return memberships.get(`${workspaceId}:${userId}`) ?? null;
    },
    async getCampaign(campaignId) {
      return campaigns.get(campaignId) ?? null;
    },
    async listCampaigns(workspaceId) {
      return [...campaigns.values()].filter((c) => c.workspaceId === workspaceId);
    },
    async insertCampaign(c) {
      const row: StoredCampaign = {
        ...c,
        currentPolicyVersionId: null,
        createdAt: now,
        updatedAt: now,
      };
      campaigns.set(c.id, row);
      return row;
    },
    async updateCampaign(id, patch) {
      const row = campaigns.get(id);
      if (!row) throw new Error("Campaign not found");
      const next = { ...row, ...patch, updatedAt: now };
      campaigns.set(id, next);
      return next;
    },
    async getVersion(campaignId, version) {
      return (versions.get(campaignId) ?? []).find((v) => v.version === version) ?? null;
    },
    async getCurrentVersion(campaignId) {
      return current(campaignId);
    },
    async insertVersion(v) {
      const row: StoredPolicyVersion = {
        ...v,
        approvedByUserId: null,
        approvedAt: null,
        createdAt: now,
      } as StoredPolicyVersion;
      const list = versions.get(v.campaignId) ?? [];
      list.push(row);
      versions.set(v.campaignId, list);
      return row;
    },
    async updateVersion(campaignId, version, patch) {
      const list = versions.get(campaignId) ?? [];
      const idx = list.findIndex((v) => v.version === version);
      if (idx === -1) throw new Error("Policy version not found");
      const next = { ...list[idx], ...patch };
      list[idx] = next;
      return next;
    },
    async atomic<T>(
      audit: AuditSink,
      work: (scoped: { store: FundingStore; audit: AuditSink }) => Promise<T>,
    ): Promise<T> {
      // Snapshot/restore gives the same all-or-nothing semantics as a DB
      // transaction. Audit events are buffered and replayed into the real
      // sink only when work succeeds, so a rollback emits nothing.
      const snapCampaigns = new Map(campaigns);
      const snapVersions = new Map([...versions].map(([k, v]) => [k, [...v]] as const));
      const snapWorkspaces = new Map(workspaceRows);
      const snapFundings = new Map(fundings);
      const snapPartners = new Map(partnerRows);
      const snapPartnerByUser = new Map(partnerByUser);
      const snapMarkets = new Map(marketStates);
      const snapTerms = new Map(termsRows);
      const snapTermsByPair = new Map(termsByPair);
      const snapReferrals = new Map(referrals);
      const snapReferralsByCode = new Map(referralsByCode);
      const snapEvents = [...referralEvents];
      const snapInvites = new Map(invites);
      const snapDecisions = [...decisions];
      const snapDecisionKeys = new Set(decisionKeys);
      const snapNegotiations = new Map(negotiations);
      const snapNegotiationDecisions = [...negotiationDecisions];
      const snapSupplyCommitments = new Map(supplyCommitments);
      const snapNegotiationDecisionKeys = new Set(negotiationDecisionKeys);
      const snapAttr = new Map(attrSessions);
      const snapIntents = new Map(intents);
      const snapIntentsByOrder = new Map(intentsByOrder);
      const snapOutcomes = new Map(outcomes);
      const snapOutcomesByIntent = new Map(outcomesByIntent);
      const snapOutcomesByTx = new Map(outcomesByTx);
      const snapReservations = new Map(reservations);
      const snapReservationsByOutcome = new Map(reservationsByOutcome);
      const snapPayouts = new Map(payouts);
      const snapPayoutsByOutcome = new Map(payoutsByOutcome);
      const snapPayoutsByReservation = new Map(payoutsByReservation);
      const buffered: Array<Parameters<AuditSink>[0]> = [];
      const bufferedAudit: AuditSink = (async (input) => {
        buffered.push(input);
        return { id: `evt-buf-${buffered.length}` };
      }) as AuditSink;
      try {
        const result = await work({ store: self as unknown as FundingStore, audit: bufferedAudit });
        for (const input of buffered) await audit(input);
        return result;
      } catch (e) {
        campaigns.clear();
        for (const [k, v] of snapCampaigns) campaigns.set(k, v);
        versions.clear();
        for (const [k, v] of snapVersions) versions.set(k, [...v]);
        workspaceRows.clear();
        for (const [k, v] of snapWorkspaces) workspaceRows.set(k, v);
        fundings.clear();
        for (const [k, v] of snapFundings) fundings.set(k, v);
        partnerRows.clear();
        for (const [k, v] of snapPartners) partnerRows.set(k, v);
        partnerByUser.clear();
        for (const [k, v] of snapPartnerByUser) partnerByUser.set(k, v);
        marketStates.clear();
        for (const [k, v] of snapMarkets) marketStates.set(k, v);
        termsRows.clear();
        for (const [k, v] of snapTerms) termsRows.set(k, v);
        termsByPair.clear();
        for (const [k, v] of snapTermsByPair) termsByPair.set(k, v);
        referrals.clear();
        for (const [k, v] of snapReferrals) referrals.set(k, v);
        referralsByCode.clear();
        for (const [k, v] of snapReferralsByCode) referralsByCode.set(k, v);
        referralEvents.length = 0;
        referralEvents.push(...snapEvents);
        invites.clear();
        for (const [k, v] of snapInvites) invites.set(k, v);
        decisions.length = 0;
        decisions.push(...snapDecisions);
        decisionKeys.clear();
        for (const k of snapDecisionKeys) decisionKeys.add(k);
        negotiations.clear();
        for (const [k, v] of snapNegotiations) negotiations.set(k, v);
        negotiationDecisions.length = 0;
        negotiationDecisions.push(...snapNegotiationDecisions);
        supplyCommitments.clear();
        for (const [k, v] of snapSupplyCommitments) supplyCommitments.set(k, v);
        negotiationDecisionKeys.clear();
        for (const k of snapNegotiationDecisionKeys) negotiationDecisionKeys.add(k);
        attrSessions.clear();
        for (const [k, v] of snapAttr) attrSessions.set(k, v);
        intents.clear();
        for (const [k, v] of snapIntents) intents.set(k, v);
        intentsByOrder.clear();
        for (const [k, v] of snapIntentsByOrder) intentsByOrder.set(k, v);
        outcomes.clear();
        for (const [k, v] of snapOutcomes) outcomes.set(k, v);
        outcomesByIntent.clear();
        for (const [k, v] of snapOutcomesByIntent) outcomesByIntent.set(k, v);
        outcomesByTx.clear();
        for (const [k, v] of snapOutcomesByTx) outcomesByTx.set(k, v);
        reservations.clear();
        for (const [k, v] of snapReservations) reservations.set(k, v);
        reservationsByOutcome.clear();
        for (const [k, v] of snapReservationsByOutcome) reservationsByOutcome.set(k, v);
        payouts.clear();
        for (const [k, v] of snapPayouts) payouts.set(k, v);
        payoutsByOutcome.clear();
        for (const [k, v] of snapPayoutsByOutcome) payoutsByOutcome.set(k, v);
        payoutsByReservation.clear();
        for (const [k, v] of snapPayoutsByReservation) payoutsByReservation.set(k, v);
        throw e;
      }
    },
    async getWorkspace(workspaceId) {
      return workspaceRows.get(workspaceId) ?? null;
    },
    async setCompanyWallet(workspaceId, address) {
      const row = workspaceRows.get(workspaceId);
      if (!row) throw new Error("Workspace not found");
      const next = { ...row, companyWallet: address };
      workspaceRows.set(workspaceId, next);
      return next;
    },
    async getFunding(campaignId, policyVersion) {
      return fundings.get(`${campaignId}:${policyVersion}`) ?? null;
    },
    async insertFunding(f) {
      const key = `${f.campaignId}:${f.policyVersion}`;
      if (fundings.has(key)) throw new Error("Funding already exists");
      const row: StoredFunding = {
        ...f,
        status: "PREPARED",
        createTxHash: null,
        approveTxHash: null,
        fundingTxHash: null,
        blockNumber: null,
        observedAmountMicroUsdc: null,
        failureCode: null,
        submittedAt: null,
        confirmedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      fundings.set(key, row);
      return row;
    },
    async updateFunding(campaignId, policyVersion, patch) {
      const key = `${campaignId}:${policyVersion}`;
      const row = fundings.get(key);
      if (!row) throw new Error("Funding not found");
      const next = { ...row, ...patch, updatedAt: now };
      fundings.set(key, next);
      return next;
    },
    async getPartnerByUserId(userId) {
      const id = partnerByUser.get(userId);
      if (!id) return null;
      return partnerRows.get(id) ?? null;
    },
    async getPartnerById(partnerId) {
      return partnerRows.get(partnerId) ?? null;
    },
    async listAutoJoinPartners() {
      return [...partnerRows.values()].filter((p) => (p.rulesJson as Record<string, unknown>)?.autoJoin === true);
    },
    async updatePartnerRules(partnerId, rulesJson) {
      const row = partnerRows.get(partnerId);
      if (!row) throw new Error("Partner not found");
      const next = { ...row, rulesJson };
      partnerRows.set(partnerId, next);
      return next;
    },
    async updatePartnerWallet(partnerId, wallet) {
      const row = partnerRows.get(partnerId);
      if (!row) throw new Error("Partner not found");
      const next = { ...row, payoutWallet: wallet };
      partnerRows.set(partnerId, next);
      return next;
    },
    async getMarket(campaignId) {
      return marketStates.get(campaignId) ?? null;
    },
    async listMarkets() {
      return [...marketStates.values()];
    },
    async insertMarket(m) {
      if (marketStates.has(m.campaignId)) throw uniqueViolation("Market already open");
      const row: StoredMarket = { ...m, openedAt: now, updatedAt: now };
      marketStates.set(m.campaignId, row);
      return row;
    },
    async getTerms(campaignId, partnerId) {
      const id = termsByPair.get(`${campaignId}:${partnerId}`);
      if (!id) return null;
      return termsRows.get(id) ?? null;
    },
    async listPartnerTerms(partnerId) {
      return [...termsRows.values()].filter((t) => t.partnerId === partnerId);
    },
    async insertTerms(t) {
      const pair = `${t.campaignId}:${t.partnerId}`;
      if (termsByPair.has(pair)) throw uniqueViolation("Partner terms already exist");
      const row: StoredTerms = { ...t, status: "ACTIVE", createdAt: now, updatedAt: now };
      termsRows.set(t.id, row);
      termsByPair.set(pair, t.id);
      return row;
    },
    async lockPartnerRow(partnerId) {
      if (!partnerRows.has(partnerId)) throw new Error("Partner not found");
    },
    async insertReferral(r) {
      if (referralsByCode.has(r.code)) throw uniqueViolation("Referral code collision");
      const row: StoredReferral = { ...r, status: "ACTIVE", createdAt: now };
      referrals.set(r.id, row);
      referralsByCode.set(r.code, r.id);
      return row;
    },
    async getReferralByCode(code) {
      const id = referralsByCode.get(code);
      if (!id) return null;
      return referrals.get(id) ?? null;
    },
    async getReferralByTerms(partnerTermsId) {
      return [...referrals.values()].find((r) => r.partnerTermsId === partnerTermsId) ?? null;
    },
    async insertReferralEvent(e) {
      referralEvents.push({ ...e, occurredAt: now });
    },
    async insertInvite(i) {
      if (invites.has(i.tokenHash)) throw uniqueViolation("Invite already exists");
      const row: StoredInvite = { ...i, uses: 0, createdAt: now };
      invites.set(i.tokenHash, row);
      return row;
    },
    async getInviteByHash(tokenHash) {
      return invites.get(tokenHash) ?? null;
    },
    async useInvite(tokenHash) {
      const row = invites.get(tokenHash);
      if (!row) throw new Error("Invite not found");
      const next = { ...row, uses: row.uses + 1 };
      invites.set(tokenHash, next);
      return next;
    },
    async insertInvitation(i) {
      for (const row of invitations.values()) {
        if (row.campaignId === i.campaignId && row.creatorUserId === i.creatorUserId && row.status === "INVITED") {
          throw uniqueViolation("Active invitation already exists");
        }
      }
      const row: StoredInvitation = {
        ...i,
        status: "INVITED",
        offeredBonusJson: i.offeredBonusJson ?? {},
        respondedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      invitations.set(i.id, row);
      return row;
    },
    async getInvitation(id) {
      return invitations.get(id) ?? null;
    },
    async findActiveInvitation(campaignId, creatorUserId) {
      for (const row of invitations.values()) {
        if (row.campaignId === campaignId && row.creatorUserId === creatorUserId && row.status === "INVITED") {
          return row;
        }
      }
      return null;
    },
    async listInvitationsByCampaign(campaignId) {
      return [...invitations.values()]
        .filter((r) => r.campaignId === campaignId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },
    async listInvitationsByCreator(creatorUserId) {
      return [...invitations.values()]
        .filter((r) => r.creatorUserId === creatorUserId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },
    async updateInvitationStatus(id, status) {
      const row = invitations.get(id);
      if (!row) throw new Error("Invitation not found");
      const next = {
        ...row,
        status,
        respondedAt: row.respondedAt ?? now,
        updatedAt: now,
      };
      invitations.set(id, next);
      return next;
    },
    async updateMarket(campaignId, expectedVersion, patch) {
      const row = marketStates.get(campaignId);
      if (!row) throw new Error("Market not found");
      if (row.version !== expectedVersion) {
        throw Object.assign(new Error("Stale market version"), {
          status: 409,
          code: "STALE_MARKET",
          details: { expected: expectedVersion, current: row.version },
        });
      }
      const next = { ...row, ...patch, updatedAt: now };
      marketStates.set(campaignId, next);
      return next;
    },
    async insertNegotiation(n) {
      for (const row of negotiations.values()) {
        if (
          row.campaignId === n.campaignId &&
          row.partnerId === n.partnerId &&
          (row.status === "OPEN" || row.status === "COUNTERED" || row.status === "HOLD")
        ) {
          throw uniqueViolation("An active negotiation already exists for this pair");
        }
      }
      const row: StoredNegotiation = {
        ...n,
        round: 1,
        status: "OPEN",
        counterMicroUsdc: null,
        createdAt: now,
        updatedAt: now,
      };
      negotiations.set(n.id, row);
      return row;
    },
    async getNegotiation(id) {
      return negotiations.get(id) ?? null;
    },
    async getActiveNegotiation(campaignId, partnerId) {
      for (const row of negotiations.values()) {
        if (
          row.campaignId === campaignId &&
          row.partnerId === partnerId &&
          (row.status === "OPEN" || row.status === "COUNTERED" || row.status === "HOLD")
        ) {
          return row;
        }
      }
      return null;
    },
    async updateNegotiation(id, patch) {
      const row = negotiations.get(id);
      if (!row) throw new Error("Negotiation not found");
      if (patch.status === "OPEN" || patch.status === "COUNTERED" || patch.status === "HOLD") {
        for (const other of negotiations.values()) {
          if (
            other.id !== id &&
            other.campaignId === row.campaignId &&
            other.partnerId === row.partnerId &&
            (other.status === "OPEN" || other.status === "COUNTERED" || other.status === "HOLD")
          ) {
            throw uniqueViolation("An active negotiation already exists for this pair");
          }
        }
      }
      const next = { ...row, ...patch, updatedAt: now };
      negotiations.set(id, next);
      return next;
    },
    async listActionableNegotiations(limit) {
      return [...negotiations.values()]
        .filter((r) => r.status === "OPEN" || r.status === "COUNTERED")
        .slice(0, limit);
    },
    async insertSupplyCommitment(c) {
      for (const row of supplyCommitments.values()) {
        if (row.negotiationId === c.negotiationId) throw uniqueViolation("Commitment already exists for negotiation");
      }
      const row: StoredSupplyCommitment = {
        ...c,
        state: "ACTIVE",
        consumedByOutcomeId: null,
        consumedByReservationId: null,
        releasedReason: null,
        createdAt: now,
        updatedAt: now,
      };
      supplyCommitments.set(c.id, row);
      return row;
    },
    async getCommitmentByNegotiation(negotiationId) {
      for (const row of supplyCommitments.values()) {
        if (row.negotiationId === negotiationId) return row;
      }
      return null;
    },
    async getCommitmentByOutcome(outcomeId) {
      for (const row of supplyCommitments.values()) {
        if (row.consumedByOutcomeId === outcomeId) return row;
      }
      return null;
    },
    async getCommitmentByTerms(partnerTermsId) {
      for (const row of supplyCommitments.values()) {
        if (row.partnerTermsId === partnerTermsId && row.state === "ACTIVE") return row;
      }
      return null;
    },
    async listActiveCommitments(campaignId) {
      return [...supplyCommitments.values()].filter((r) => r.campaignId === campaignId && r.state === "ACTIVE");
    },
    async updateSupplyCommitment(id, patch) {
      const row = supplyCommitments.get(id);
      if (!row) throw new Error("Commitment not found");
      const next = { ...row, ...patch, updatedAt: now };
      supplyCommitments.set(id, next);
      return next;
    },
    async updateTermsStatus(termsId, status) {
      const terms = termsRows.get(termsId);
      if (!terms) throw new Error("Terms not found");
      const next = { ...terms, status, updatedAt: now };
      termsRows.set(termsId, next);
      return next;
    },
    async insertNegotiationDecision(d) {
      const key = `${d.negotiationId}:${d.inputsHash}`;
      if (negotiationDecisionKeys.has(key)) throw uniqueViolation("Negotiation decision already recorded");
      const row: StoredNegotiationDecision = { ...d, createdAt: now };
      negotiationDecisions.push(row);
      negotiationDecisionKeys.add(key);
      return row;
    },
    async getLatestNegotiationDecision(negotiationId) {
      const rows = negotiationDecisions.filter((dd) => dd.negotiationId === negotiationId);
      return rows.length === 0 ? null : rows[rows.length - 1];
    },
    async insertPricingDecision(d) {
      const key = `${d.campaignId}:${d.inputsHash}`;
      if (decisionKeys.has(key)) throw uniqueViolation("Pricing decision already recorded for this state");
      const row: StoredPricingDecision = { ...d, createdAt: now };
      decisions.push(row);
      decisionKeys.add(key);
      return row;
    },
    async getLatestPricingDecision(campaignId) {
      const rows = decisions.filter((dd) => dd.campaignId === campaignId);
      return rows.length === 0 ? null : rows[rows.length - 1];
    },
    async getLastExecutedRepriceAt(campaignId) {
      const rows = decisions.filter(
        (dd) => dd.campaignId === campaignId && dd.decision === "REPRICE" && dd.autoExecuted,
      );
      return rows.length === 0 ? null : rows[rows.length - 1].createdAt;
    },
    async countTermsSince(campaignId, since) {
      return [...termsRows.values()].filter((t) => t.campaignId === campaignId && t.createdAt >= since).length;
    },
    async countVerifiedOutcomesSince(campaignId, since) {
      return [...outcomes.values()].filter(
        (o) => o.campaignId === campaignId && o.status === "VERIFIED" && o.verifiedAt !== null && o.verifiedAt >= since,
      ).length;
    },
    async countVerifiedOutcomes(campaignId) {
      return [...outcomes.values()].filter((o) => o.campaignId === campaignId && o.status === "VERIFIED").length;
    },
    async insertAttributionSession(s) {
      if (attrSessions.has(s.id)) throw uniqueViolation("Attribution session exists");
      const row: StoredAttributionSession = { ...s, usedAt: null, createdAt: now };
      attrSessions.set(s.id, row);
      return row;
    },
    async getAttributionSession(id) {
      return attrSessions.get(id) ?? null;
    },
    async consumeAttributionSession(id) {
      const row = attrSessions.get(id);
      if (!row || row.usedAt) return null;
      const next = { ...row, usedAt: now };
      attrSessions.set(id, next);
      return next;
    },
    async insertCheckoutIntent(i) {
      if (intentsByOrder.has(i.orderId)) throw uniqueViolation("Order ID collision");
      const row: StoredCheckoutIntent = {
        ...i,
        status: "PREPARED",
        txHash: null,
        submittedAt: null,
        confirmedAt: null,
        failureCode: null,
        createdAt: now,
        updatedAt: now,
      };
      intents.set(i.id, row);
      intentsByOrder.set(i.orderId, i.id);
      return row;
    },
    async getCheckoutIntent(id) {
      return intents.get(id) ?? null;
    },
    async updateCheckoutIntent(id, patch) {
      const row = intents.get(id);
      if (!row) throw new Error("Checkout intent not found");
      if (patch.txHash && [...intents.values()].some((o) => o.id !== id && o.txHash === patch.txHash)) {
        throw uniqueViolation("Transaction hash already submitted");
      }
      const next = { ...row, ...patch, updatedAt: now };
      intents.set(id, next);
      return next;
    },
    async insertOutcome(o) {
      if (outcomesByIntent.has(o.checkoutIntentId)) throw uniqueViolation("Outcome already exists for intent");
      if (outcomesByTx.has(o.purchaseTx)) throw uniqueViolation("Purchase tx already used");
      const row: StoredOutcome = {
        ...o,
        status: "PENDING",
        proofHash: null,
        blockNumber: null,
        occurredAt: null,
        verifiedAt: null,
        holdUntil: null,
        rejectionCode: null,
        createdAt: now,
        updatedAt: now,
      };
      outcomes.set(o.id, row);
      outcomesByIntent.set(o.checkoutIntentId, o.id);
      outcomesByTx.set(o.purchaseTx, o.id);
      return row;
    },
    async getOutcome(id) {
      return outcomes.get(id) ?? null;
    },
    async getOutcomeByIntent(checkoutIntentId) {
      const id = outcomesByIntent.get(checkoutIntentId);
      if (!id) return null;
      return outcomes.get(id) ?? null;
    },
    async getOutcomeByTx(purchaseTx) {
      const id = outcomesByTx.get(purchaseTx);
      if (!id) return null;
      return outcomes.get(id) ?? null;
    },
    async getOutcomeByCustomer(campaignId, customerKeyHash) {
      return [...outcomes.values()].find((o) => o.campaignId === campaignId && o.customerKeyHash === customerKeyHash) ?? null;
    },
    async listOutcomesByStatus(status, limit) {
      return [...outcomes.values()].filter((o) => o.status === status).slice(0, limit);
    },
    async insertReservation(r) {
      if (reservationsByOutcome.has(r.outcomeId)) throw uniqueViolation("Reservation already exists for outcome");
      const row: StoredReservation = { ...r, state: "RESERVED", expiresAt: null, createdAt: now, updatedAt: now };
      reservations.set(r.id, row);
      reservationsByOutcome.set(r.outcomeId, r.id);
      return row;
    },
    async getReservation(id) {
      return reservations.get(id) ?? null;
    },
    async getReservationByOutcome(outcomeId) {
      const id = reservationsByOutcome.get(outcomeId);
      if (!id) return null;
      return reservations.get(id) ?? null;
    },
    async listReservationsByCampaign(campaignId) {
      return [...reservations.values()].filter((r) => r.campaignId === campaignId);
    },
    async updateReservation(id, patch) {
      const row = reservations.get(id);
      if (!row) throw new Error("Reservation not found");
      const next = { ...row, ...patch, updatedAt: now };
      reservations.set(id, next);
      return next;
    },
    async insertPayout(p) {
      if (payoutsByOutcome.has(p.outcomeId)) throw uniqueViolation("Payout already exists for outcome");
      if (payoutsByReservation.has(p.reservationId)) throw uniqueViolation("Payout already exists for reservation");
      const row: StoredPayout = {
        ...p,
        verifierSignature: null,
        txHash: null,
        state: "PREPARED",
        blockNumber: null,
        submittedAt: null,
        settledAt: null,
        reconciledAt: null,
        failureCode: null,
        createdAt: now,
        updatedAt: now,
      };
      payouts.set(p.id, row);
      payoutsByOutcome.set(p.outcomeId, p.id);
      payoutsByReservation.set(p.reservationId, p.id);
      return row;
    },
    async getPayout(id) {
      return payouts.get(id) ?? null;
    },
    async getPayoutByOutcome(outcomeId) {
      const id = payoutsByOutcome.get(outcomeId);
      if (!id) return null;
      return payouts.get(id) ?? null;
    },
    async getPayoutByReservation(reservationId) {
      const id = payoutsByReservation.get(reservationId);
      if (!id) return null;
      return payouts.get(id) ?? null;
    },
    async updatePayout(id, patch) {
      const row = payouts.get(id);
      if (!row) throw new Error("Payout not found");
      if (patch.txHash && [...payouts.values()].some((o) => o.id !== id && o.txHash === patch.txHash)) {
        throw uniqueViolation("Transaction hash already used");
      }
      const next = { ...row, ...patch, updatedAt: now };
      payouts.set(id, next);
      return next;
    },
    async updateOutcome(id, patch) {
      const row = outcomes.get(id);
      if (!row) throw new Error("Outcome not found");
      if (patch.purchaseTx && patch.purchaseTx !== row.purchaseTx) {
        if (outcomesByTx.has(patch.purchaseTx)) throw uniqueViolation("Purchase tx already used");
        outcomesByTx.delete(row.purchaseTx);
        outcomesByTx.set(patch.purchaseTx, id);
      }
      const next = { ...row, ...patch, updatedAt: now };
      outcomes.set(id, next);
      return next;
    },
  };
  return self;
}

/** In-memory audit sink for tests; asserts on the recorded events. */
export function createMemoryAuditSink() {
  const events: Array<{ action: string; metadata: Record<string, unknown> }> = [];
  const sink: AuditSink = async (input) => {
    events.push({ action: input.action, metadata: input.metadata ?? {} });
    return { id: `evt-${events.length}` };
  };
  return { sink, events };
}
