/**
 * Core Thesma vocabulary for S0.
 *
 * These enums are intentionally behavior-free. They exist so later slices
 * (S1 campaign intent + policy engine, S6 pricing, S7 negotiation) share one
 * typed language. No business logic lives here.
 *
 * Source: Thesma_PRD_Architecture_Build_Plan.md sections 4-6,
 * Thesma_Product_Idea.md section 6, Thesma messaging.md section 7.2.
 */

/** Workspace membership roles. PARTNER allows a partner user to be scoped to a workspace. */
export const WORKSPACE_ROLES = [
  "ORGANIZATION_OWNER",
  "ORGANIZATION_MEMBER",
  "PARTNER",
] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** Campaign lifecycle (PRD section 6). No campaign behavior in S0. */
export const CAMPAIGN_STATES = [
  "DRAFT",
  "REVIEW",
  "APPROVED",
  "FUNDING",
  "LIVE",
  "PAUSED",
  "CLOSING",
  "CLOSED",
] as const;
export type CampaignState = (typeof CAMPAIGN_STATES)[number];

/** Market pace/state vocabulary (product idea section 6). */
export const MARKET_STATES = [
  "OPEN",
  "THIN_SUPPLY",
  "ON_PACE",
  "BEHIND_PACE",
  "BUDGET_PRESSURE",
  "TARGET_REACHED",
  "PAUSED",
  "CLOSED",
] as const;
export type MarketState = (typeof MARKET_STATES)[number];

/** Agent action states (PRD section 4.3). */
export const AGENT_ACTION_STATES = [
  "RECOMMEND",
  "PREPARE",
  "EXECUTE",
  "HOLD",
  "REFUSE",
  "ESCALATE",
] as const;
export type AgentActionState = (typeof AGENT_ACTION_STATES)[number];

/** Owner-controlled policy fields can never be changed by an agent (PRD 4.4). Listed here for S1. */
export const OWNER_CONTROLLED_POLICY_FIELDS = [
  "targetOutcomeCount",
  "budgetUSDC",
  "bountyFloor",
  "bountyCeiling",
  "minQualifyingPurchase",
  "deadline",
  "marketVisibility",
] as const;
export type OwnerControlledPolicyField =
  (typeof OWNER_CONTROLLED_POLICY_FIELDS)[number];
