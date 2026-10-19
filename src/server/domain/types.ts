import type {
  AgentActionState,
  CampaignState,
  MarketState,
  WorkspaceRole,
} from "./enums";

export type {
  AgentActionState,
  CampaignState,
  MarketState,
  WorkspaceRole,
};

/** Branded ID helpers keep foreign keys type-distinct without runtime cost. */
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type UserId = Brand<string, "UserId">;
export type WorkspaceId = Brand<string, "WorkspaceId">;
export type WorkspaceMemberId = Brand<string, "WorkspaceMemberId">;
export type PartnerId = Brand<string, "PartnerId">;
export type SessionId = Brand<string, "SessionId">;
export type AuditEventId = Brand<string, "AuditEventId">;

export interface User {
  id: UserId;
  email: string;
  name: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Workspace {
  id: WorkspaceId;
  ownerUserId: UserId;
  name: string;
  /** Nullable in S0. Arc/company wallet wiring lands in S1+. */
  companyWallet: string | null;
  category: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkspaceMember {
  id: WorkspaceMemberId;
  workspaceId: WorkspaceId;
  userId: UserId;
  role: WorkspaceRole;
  createdAt: Date;
}

export interface PartnerRules {
  minBountyMicroUSDC?: string | null;
  allowedCategories?: string[];
  blockedCategories?: string[];
  maxActiveCampaigns?: number | null;
  autoJoin?: boolean;
  autoNegotiate?: boolean;
  maxAllocation?: number | null;
  minScoutConfidence?: "HIGH" | "MEDIUM" | "LOW";
  maxAutoJoinsPerDay?: number | null;
}

export interface Partner {
  id: PartnerId;
  userId: UserId;
  /** Nullable in S0. Payout wallet wiring lands with vault/executor slices. */
  payoutWallet: string | null;
  categories: string[];
  rulesJson: PartnerRules;
  reputationSummary: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ActorType = "USER" | "SYSTEM" | "AGENT";

export interface AuditEvent {
  id: AuditEventId;
  actorType: ActorType;
  actorId: string | null;
  workspaceId: WorkspaceId | null;
  partnerId: PartnerId | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}
