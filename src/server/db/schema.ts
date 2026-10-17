import {
  bigint,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * S0 identity/workspace foundation only.
 * Future slices add: campaigns, market_state, partner_terms, offers,
 * referrals, events, outcomes, spend_reservations, payouts, agent_decisions.
 *
 * ID strategy: app-generated randomUUID() text PKs. No Postgres extension
 * (e.g. pgcrypto) required, keeps DATABASE_URL provider-neutral.
 */

export const workspaceRoleEnum = pgEnum("workspace_role", [
  "ORGANIZATION_OWNER",
  "ORGANIZATION_MEMBER",
  "PARTNER",
]);

export const actorTypeEnum = pgEnum("actor_type", ["USER", "SYSTEM", "AGENT"]);

/** Full lifecycle vocabulary. S1 may only enter DRAFT | REVIEW | APPROVED. */
export const campaignStateEnum = pgEnum("campaign_state", [
  "DRAFT",
  "REVIEW",
  "APPROVED",
  "FUNDING",
  "LIVE",
  "PAUSED",
  "CLOSING",
  "CLOSED",
]);

export const policyVersionStatusEnum = pgEnum("policy_version_status", [
  "DRAFT",
  "REVIEW",
  "APPROVED",
]);

export const marketVisibilityEnum = pgEnum("market_visibility", ["PUBLIC", "PRIVATE"]);

export const fundingStatusEnum = pgEnum("funding_status", [
  "PREPARED",
  "SUBMITTED",
  "CONFIRMED",
  "FAILED",
  "AMBIGUOUS",
]);

export const marketStatusEnum = pgEnum("market_status", [
  "OPEN",
  "THIN_SUPPLY",
  "ON_PACE",
  "BEHIND_PACE",
  "BUDGET_PRESSURE",
  "TARGET_REACHED",
  "PAUSED",
  "CLOSED",
]);

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    name: text("name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_email_unique").on(t.email)],
);

export const workspaces = pgTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    companyWallet: text("company_wallet"),
    category: text("category"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("workspaces_owner_idx").on(t.ownerUserId)],
);

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: workspaceRoleEnum("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("workspace_members_workspace_user_unique").on(t.workspaceId, t.userId),
    index("workspace_members_workspace_idx").on(t.workspaceId),
    index("workspace_members_user_idx").on(t.userId),
  ],
);

export const partners = pgTable(
  "partners",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    payoutWallet: text("payout_wallet"),
    categories: text("categories").array().notNull().default([]),
    rulesJson: jsonb("rules_json").notNull().default({}),
    reputationSummary: text("reputation_summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("partners_user_unique").on(t.userId)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("sessions_token_hash_unique").on(t.tokenHash),
    index("sessions_user_idx").on(t.userId),
  ],
);

/**
 * Append-only audit primitive for S0 (workspace + partner mutations).
 * This is NOT the later financial receipt system — it only proves
 * "who did what, when" for foundation mutations.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    actorType: actorTypeEnum("actor_type").notNull(),
    actorId: text("actor_id"),
    workspaceId: text("workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    partnerId: text("partner_id").references(() => partners.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_events_workspace_idx").on(t.workspaceId),
    index("audit_events_partner_idx").on(t.partnerId),
    index("audit_events_action_idx").on(t.action),
    index("audit_events_created_idx").on(t.createdAt),
  ],
);

export const campaigns = pgTable(
  "campaigns",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    state: campaignStateEnum("state").notNull().default("DRAFT"),
    currentPolicyVersionId: text("current_policy_version_id"),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("campaigns_workspace_idx").on(t.workspaceId)],
);

export const campaignPolicyVersions = pgTable(
  "campaign_policy_versions",
  {
    id: text("id").primaryKey(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    intentText: text("intent_text").notNull(),
    targetOutcomeCount: integer("target_outcome_count"),
    budgetMicroUsdc: bigint("budget_micro_usdc", { mode: "bigint" }),
    bountyFloorMicroUsdc: bigint("bounty_floor_micro_usdc", { mode: "bigint" }),
    bountyCeilingMicroUsdc: bigint("bounty_ceiling_micro_usdc", { mode: "bigint" }),
    minQualifyingPurchaseMicroUsdc: bigint("min_qualifying_purchase_micro_usdc", { mode: "bigint" }),
    deadline: timestamp("deadline", { withTimezone: true }),
    marketVisibility: marketVisibilityEnum("market_visibility").notNull().default("PUBLIC"),
    allowedPartnerRulesJson: jsonb("allowed_partner_rules_json").notNull().default({}),
    refundHoldSeconds: integer("refund_hold_seconds").notNull().default(0),
    escalationRulesJson: jsonb("escalation_rules_json").notNull().default({}),
    status: policyVersionStatusEnum("status").notNull().default("DRAFT"),
    approvedByUserId: text("approved_by_user_id").references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("campaign_policy_versions_campaign_version_unique").on(t.campaignId, t.version),
    index("campaign_policy_versions_campaign_idx").on(t.campaignId),
  ],
);

/**
 * S2 funding records. One row per (campaignId, policyVersion): a confirmed
 * funding pins the exact campaignKey/policyHash/amount proven onchain.
 * This is acquisition-budget evidence only — customer revenue never appears here.
 */
export const campaignFundings = pgTable(
  "campaign_fundings",
  {
    id: text("id").primaryKey(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    policyVersionId: text("policy_version_id")
      .notNull()
      .references(() => campaignPolicyVersions.id, { onDelete: "cascade" }),
    policyVersion: integer("policy_version").notNull(),
    campaignKey: text("campaign_key").notNull(),
    policyHash: text("policy_hash").notNull(),
    chainId: integer("chain_id").notNull(),
    vaultAddress: text("vault_address").notNull(),
    usdcAddress: text("usdc_address").notNull(),
    ownerAddress: text("owner_address").notNull(),
    expectedAmountMicroUsdc: bigint("expected_amount_micro_usdc", { mode: "bigint" }).notNull(),
    status: fundingStatusEnum("status").notNull().default("PREPARED"),
    createTxHash: text("create_tx_hash"),
    approveTxHash: text("approve_tx_hash"),
    fundingTxHash: text("funding_tx_hash"),
    blockNumber: integer("block_number"),
    observedAmountMicroUsdc: bigint("observed_amount_micro_usdc", { mode: "bigint" }),
    failureCode: text("failure_code"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("campaign_fundings_campaign_version_unique").on(t.campaignId, t.policyVersion),
    // Postgres treats NULLs as distinct: many un-submitted rows can coexist.
    uniqueIndex("campaign_fundings_funding_tx_unique").on(t.fundingTxHash),
    index("campaign_fundings_campaign_idx").on(t.campaignId),
  ],
);

/**
 * S3 live-market rows. One per campaign. The public bounty here is an
 * owner-approved bootstrap (S3); S6 repricing will version it further.
 */
export const marketStates = pgTable(
  "market_states",
  {
    campaignId: text("campaign_id")
      .primaryKey()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    publicBountyMicroUsdc: bigint("public_bounty_micro_usdc", { mode: "bigint" }).notNull(),
    status: marketStatusEnum("status").notNull().default("OPEN"),
    destinationUrl: text("destination_url").notNull(),
    version: integer("version").notNull().default(1),
    policyVersion: integer("policy_version").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("market_states_status_idx").on(t.status)],
);

export const partnerTerms = pgTable(
  "partner_terms",
  {
    id: text("id").primaryKey(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    partnerId: text("partner_id")
      .notNull()
      .references(() => partners.id, { onDelete: "cascade" }),
    priceMicroUsdc: bigint("price_micro_usdc", { mode: "bigint" }).notNull(),
    allocationCount: integer("allocation_count").notNull(),
    source: text("source").notNull().default("PUBLIC"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    policyVersion: integer("policy_version").notNull(),
    marketVersion: integer("market_version").notNull(),
    status: text("status").notNull().default("ACTIVE"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("partner_terms_campaign_partner_unique").on(t.campaignId, t.partnerId),
    index("partner_terms_campaign_idx").on(t.campaignId),
    index("partner_terms_partner_idx").on(t.partnerId),
  ],
);

export const referrals = pgTable(
  "referrals",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    partnerId: text("partner_id")
      .notNull()
      .references(() => partners.id, { onDelete: "cascade" }),
    partnerTermsId: text("partner_terms_id")
      .notNull()
      .references(() => partnerTerms.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("ACTIVE"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("referrals_code_unique").on(t.code),
    index("referrals_campaign_idx").on(t.campaignId),
    index("referrals_partner_idx").on(t.partnerId),
  ],
);

export const referralEvents = pgTable(
  "referral_events",
  {
    id: text("id").primaryKey(),
    referralId: text("referral_id")
      .notNull()
      .references(() => referrals.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    anonymousVisitorHash: text("anonymous_visitor_hash"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    metadataJson: jsonb("metadata_json"),
  },
  (t) => [index("referral_events_referral_idx").on(t.referralId)],
);

export const privateInvites = pgTable(
  "private_invites",
  {
    id: text("id").primaryKey(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    maxUses: integer("max_uses"),
    uses: integer("uses").notNull().default(0),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("private_invites_token_hash_unique").on(t.tokenHash),
    index("private_invites_campaign_idx").on(t.campaignId),
  ],
);

export type DbUser = typeof users.$inferSelect;
export type DbFunding = typeof campaignFundings.$inferSelect;
export type DbMarket = typeof marketStates.$inferSelect;
export type DbTerms = typeof partnerTerms.$inferSelect;
export type DbReferral = typeof referrals.$inferSelect;
export type DbReferralEvent = typeof referralEvents.$inferSelect;
export type DbInvite = typeof privateInvites.$inferSelect;
export type DbCampaign = typeof campaigns.$inferSelect;
export type DbPolicyVersion = typeof campaignPolicyVersions.$inferSelect;
export type DbWorkspace = typeof workspaces.$inferSelect;
export type DbWorkspaceMember = typeof workspaceMembers.$inferSelect;
export type DbPartner = typeof partners.$inferSelect;
export type DbSession = typeof sessions.$inferSelect;
export type DbAuditEvent = typeof auditEvents.$inferSelect;
