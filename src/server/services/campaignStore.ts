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
}): CampaignStore & { campaigns: Map<string, StoredCampaign>; versions: Map<string, StoredPolicyVersion[]> } {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const campaigns = new Map<string, StoredCampaign>();
  const versions = new Map<string, StoredPolicyVersion[]>();
  const memberships = new Map<string, StoreMembership>();
  for (const m of seed?.memberships ?? []) memberships.set(`${m.workspaceId}:${m.userId}`, m);

  const current = (campaignId: string): StoredPolicyVersion | null => {
    const list = versions.get(campaignId) ?? [];
    return list.length === 0 ? null : list[list.length - 1];
  };

  return {
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
  };
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
