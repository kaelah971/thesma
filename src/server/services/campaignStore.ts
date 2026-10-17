import type { CampaignState, WorkspaceRole } from "../domain/enums";
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
  workspaces?: StoreWorkspace[];
}): FundingStore & { campaigns: Map<string, StoredCampaign>; versions: Map<string, StoredPolicyVersion[]> } {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const campaigns = new Map<string, StoredCampaign>();
  const versions = new Map<string, StoredPolicyVersion[]>();
  const memberships = new Map<string, StoreMembership>();
  const workspaceRows = new Map<string, StoreWorkspace>();
  const fundings = new Map<string, StoredFunding>();
  for (const m of seed?.memberships ?? []) memberships.set(`${m.workspaceId}:${m.userId}`, m);
  for (const w of seed?.workspaces ?? []) workspaceRows.set(w.id, { ...w });
  // Membership implies a workspace row unless one was seeded explicitly.
  for (const m of seed?.memberships ?? []) {
    if (!workspaceRows.has(m.workspaceId)) {
      workspaceRows.set(m.workspaceId, { id: m.workspaceId, ownerUserId: m.userId, companyWallet: null });
    }
  }

  const current = (campaignId: string): StoredPolicyVersion | null => {
    const list = versions.get(campaignId) ?? [];
    return list.length === 0 ? null : list[list.length - 1];
  };

  const self: FundingStore & {
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
