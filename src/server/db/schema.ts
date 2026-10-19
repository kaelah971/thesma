import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
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

/**
 * Product persona for the role gateway (/start). This is onboarding/entry
 * state only — it never grants workspace/partner authorization, which stays
 * on workspace_members + ownership checks.
 */
export const personaEnum = pgEnum("user_persona", [
  "CUSTOMER",
  "CREATOR",
  "ORGANIZATION",
  "DEVELOPER",
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

export const checkoutStatusEnum = pgEnum("checkout_status", [
  "PREPARED",
  "SUBMITTED",
  "CONFIRMED",
  "REJECTED",
  "AMBIGUOUS",
]);

export const outcomeStatusEnum = pgEnum("outcome_status", [
  "PENDING",
  "VERIFIED",
  "REJECTED",
]);

export const reservationStateEnum = pgEnum("reservation_state", [
  "RESERVED",
  "SUBMITTED",
  "SETTLED",
  "FAILED",
  "AMBIGUOUS",
  "RELEASED",
]);

export const payoutStateEnum = pgEnum("payout_state", [
  "PREPARED",
  "SUBMITTED",
  "SETTLED",
  "FAILED",
  "AMBIGUOUS",
]);

export const pricingDecisionEnum = pgEnum("pricing_decision", [
  "KEEP",
  "REPRICE",
  "PAUSE",
]);

export const negotiationDecisionEnum = pgEnum("negotiation_decision", [
  "ACCEPT",
  "COUNTER",
  "REJECT",
  "HOLD",
]);

export const commitmentStateEnum = pgEnum("commitment_state", [
  "ACTIVE",
  "CONSUMED",
  "RELEASED",
  "EXPIRED",
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

/**
 * Human-controlled autonomous-spending authority per workspace (RFB 04).
 * The AI can never write this table — only organization owners via the
 * policy API. Missing row ⇒ conservative DEFAULT_OPERATOR_POLICY.
 */
export const operatorPolicies = pgTable("operator_policies", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  minReserveMicroUsdc: text("min_reserve_micro_usdc").notNull().default("0"),
  maxAutonomousPaymentMicroUsdc: text("max_autonomous_payment_micro_usdc").notNull().default("10000000"),
  maxAutonomousSpendPerPeriodMicroUsdc: text("max_autonomous_spend_per_period_micro_usdc"),
  updatedByUserId: text("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Human-controlled growth-optimization authority per workspace (RFB 04
 * intelligence layer). Bounty floor/ceiling stay in the campaign policy
 * version (authoritative, incl. the onchain ceiling); this table only gates
 * whether the agent may act and how far a single autonomous move may go.
 * Disabled by default: the organization opts in. The AI can never write it.
 */
export const growthPolicies = pgTable("growth_policies", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  optimizationEnabled: boolean("optimization_enabled").notNull().default(false),
  maxBountyChangePct: integer("max_bounty_change_pct").notNull().default(25),
  minimumEvidence: integer("minimum_evidence").notNull().default(5),
  evaluationWindowDays: integer("evaluation_window_days").notNull().default(7),
  updatedByUserId: text("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

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

/**
 * One row per user recording their /start persona choice plus the small
 * profile fields collected during role onboarding. Additive only: existing
 * auth, workspace and partner tables are untouched.
 */
export const userPersonas = pgTable(
  "user_personas",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    persona: personaEnum("persona").notNull(),
    handle: text("handle"),
    bio: text("bio"),
    category: text("category"),
    project: text("project"),
    onboardingCompletedAt: timestamp("onboarding_completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("user_personas_handle_unique").on(t.handle)],
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

/**
 * S4 portable attribution sessions. The opaque handle goes in the redirect
 * URL (?thesma_attribution=...); only random IDs travel, never wallets or
 * policy. Single-use: consumed when the first checkout intent is created.
 */
export const attributionSessions = pgTable(
  "attribution_sessions",
  {
    id: text("id").primaryKey(),
    referralId: text("referral_id")
      .notNull()
      .references(() => referrals.id, { onDelete: "cascade" }),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    partnerId: text("partner_id")
      .notNull()
      .references(() => partners.id, { onDelete: "cascade" }),
    partnerTermsId: text("partner_terms_id")
      .notNull()
      .references(() => partnerTerms.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("attribution_sessions_campaign_idx").on(t.campaignId)],
);

export const checkoutIntents = pgTable(
  "checkout_intents",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    policyVersionId: text("policy_version_id")
      .notNull()
      .references(() => campaignPolicyVersions.id, { onDelete: "cascade" }),
    partnerId: text("partner_id")
      .notNull()
      .references(() => partners.id, { onDelete: "cascade" }),
    partnerTermsId: text("partner_terms_id")
      .notNull()
      .references(() => partnerTerms.id, { onDelete: "cascade" }),
    attributionSessionId: text("attribution_session_id").references(() => attributionSessions.id, {
      onDelete: "set null",
    }),
    payerAddress: text("payer_address").notNull(),
    merchantAddress: text("merchant_address").notNull(),
    amountMicroUsdc: bigint("amount_micro_usdc", { mode: "bigint" }).notNull(),
    chainId: integer("chain_id").notNull(),
    usdcAddress: text("usdc_address").notNull(),
    status: checkoutStatusEnum("status").notNull().default("PREPARED"),
    txHash: text("tx_hash"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    failureCode: text("failure_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("checkout_intents_order_unique").on(t.orderId),
    uniqueIndex("checkout_intents_tx_unique").on(t.txHash),
    index("checkout_intents_campaign_idx").on(t.campaignId),
  ],
);

export const outcomes = pgTable(
  "outcomes",
  {
    id: text("id").primaryKey(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    partnerId: text("partner_id")
      .notNull()
      .references(() => partners.id, { onDelete: "cascade" }),
    partnerTermsId: text("partner_terms_id")
      .notNull()
      .references(() => partnerTerms.id, { onDelete: "cascade" }),
    checkoutIntentId: text("checkout_intent_id")
      .notNull()
      .references(() => checkoutIntents.id, { onDelete: "cascade" }),
    customerKeyHash: text("customer_key_hash").notNull(),
    purchaseTx: text("purchase_tx").notNull(),
    purchaseAmountMicroUsdc: bigint("purchase_amount_micro_usdc", { mode: "bigint" }).notNull(),
    status: outcomeStatusEnum("status").notNull().default("PENDING"),
    proofHash: text("proof_hash"),
    blockNumber: integer("block_number"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    holdUntil: timestamp("hold_until", { withTimezone: true }),
    rejectionCode: text("rejection_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("outcomes_intent_unique").on(t.checkoutIntentId),
    uniqueIndex("outcomes_purchase_tx_unique").on(t.purchaseTx),
    uniqueIndex("outcomes_campaign_customer_unique").on(t.campaignId, t.customerKeyHash),
    uniqueIndex("outcomes_proof_unique").on(t.proofHash),
    index("outcomes_campaign_idx").on(t.campaignId),
    index("outcomes_partner_idx").on(t.partnerId),
  ],
);

/**
 * S5 spend reservations: campaign-scoped budget locks. Exactly one active
 * reservation per outcome; committed amounts bound concurrent payouts so
 * simultaneous VERIFIED outcomes can never overcommit funded budget.
 */
export const spendReservations = pgTable(
  "spend_reservations",
  {
    id: text("id").primaryKey(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    outcomeId: text("outcome_id")
      .notNull()
      .references(() => outcomes.id, { onDelete: "cascade" }),
    partnerId: text("partner_id")
      .notNull()
      .references(() => partners.id, { onDelete: "cascade" }),
    partnerTermsId: text("partner_terms_id")
      .notNull()
      .references(() => partnerTerms.id, { onDelete: "cascade" }),
    amountMicroUsdc: bigint("amount_micro_usdc", { mode: "bigint" }).notNull(),
    policyVersionId: text("policy_version_id")
      .notNull()
      .references(() => campaignPolicyVersions.id, { onDelete: "cascade" }),
    state: reservationStateEnum("state").notNull().default("RESERVED"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("spend_reservations_outcome_unique").on(t.outcomeId),
    index("spend_reservations_campaign_idx").on(t.campaignId),
  ],
);

export const payouts = pgTable(
  "payouts",
  {
    id: text("id").primaryKey(),
    reservationId: text("reservation_id")
      .notNull()
      .references(() => spendReservations.id, { onDelete: "cascade" }),
    outcomeId: text("outcome_id")
      .notNull()
      .references(() => outcomes.id, { onDelete: "cascade" }),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    partnerId: text("partner_id")
      .notNull()
      .references(() => partners.id, { onDelete: "cascade" }),
    recipient: text("recipient").notNull(),
    amountMicroUsdc: bigint("amount_micro_usdc", { mode: "bigint" }).notNull(),
    proofHash: text("proof_hash").notNull(),
    verifierSignature: text("verifier_signature"),
    txHash: text("tx_hash"),
    state: payoutStateEnum("state").notNull().default("PREPARED"),
    blockNumber: integer("block_number"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    failureCode: text("failure_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("payouts_reservation_unique").on(t.reservationId),
    uniqueIndex("payouts_outcome_unique").on(t.outcomeId),
    uniqueIndex("payouts_tx_unique").on(t.txHash),
    index("payouts_campaign_idx").on(t.campaignId),
    index("payouts_outcome_idx").on(t.outcomeId),
  ],
);

/**
 * S6 pricing decisions: one row per evaluation that acts or is recorded.
 * inputsHash (marketVersion + canonical inputs) makes repeat evaluations
 * idempotent: the same state can never produce two rows.
 */
export const marketDecisions = pgTable(
  "market_decisions",
  {
    id: text("id").primaryKey(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    marketVersion: integer("market_version").notNull(),
    decision: pricingDecisionEnum("decision").notNull(),
    paceState: text("pace_state").notNull(),
    reasonCodes: text("reason_codes").array().notNull().default([]),
    inputsJson: jsonb("inputs_json").notNull(),
    inputsHash: text("inputs_hash").notNull(),
    oldBountyMicroUsdc: bigint("old_bounty_micro_usdc", { mode: "bigint" }),
    newBountyMicroUsdc: bigint("new_bounty_micro_usdc", { mode: "bigint" }),
    autoExecuted: integer("auto_executed").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("market_decisions_campaign_hash_unique").on(t.campaignId, t.inputsHash),
    index("market_decisions_campaign_idx").on(t.campaignId),
  ],
);

/**
 * S7 supplier negotiations: one row per campaign+partner round-track.
 * Exactly one non-terminal row per pair (partial unique index); terminal
 * rows (ACCEPTED/REJECTED/EXPIRED/WITHDRAWN) free the pair for a fresh start.
 * Status transitions happen only through the deterministic kernel.
 */
export const negotiations = pgTable(
  "negotiations",
  {
    id: text("id").primaryKey(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    partnerId: text("partner_id")
      .notNull()
      .references(() => partners.id, { onDelete: "cascade" }),
    round: integer("round").notNull().default(1),
    status: text("status").notNull().default("OPEN"),
    askMicroUsdc: bigint("ask_micro_usdc", { mode: "bigint" }).notNull(),
    referenceBountyMicroUsdc: bigint("reference_bounty_micro_usdc", { mode: "bigint" }).notNull(),
    counterMicroUsdc: bigint("counter_micro_usdc", { mode: "bigint" }),
    policyVersion: integer("policy_version").notNull(),
    marketVersion: integer("market_version").notNull(),
    allocationCount: integer("allocation_count").notNull().default(1),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("negotiations_pair_active_unique")
      .on(t.campaignId, t.partnerId)
      .where(sql`status IN ('OPEN', 'COUNTERED', 'HOLD')`),
    index("negotiations_campaign_idx").on(t.campaignId),
    index("negotiations_status_idx").on(t.status),
  ],
);

export const negotiationDecisions = pgTable(
  "negotiation_decisions",
  {
    id: text("id").primaryKey(),
    negotiationId: text("negotiation_id")
      .notNull()
      .references(() => negotiations.id, { onDelete: "cascade" }),
    round: integer("round").notNull(),
    decision: negotiationDecisionEnum("decision").notNull(),
    reasonCodes: text("reason_codes").array().notNull().default([]),
    inputsJson: jsonb("inputs_json").notNull(),
    inputsHash: text("inputs_hash").notNull(),
    askMicroUsdc: bigint("ask_micro_usdc", { mode: "bigint" }).notNull(),
    counterMicroUsdc: bigint("counter_micro_usdc", { mode: "bigint" }),
    autoExecuted: integer("auto_executed").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("negotiation_decisions_inputs_unique").on(t.negotiationId, t.inputsHash),
    index("negotiation_decisions_negotiation_idx").on(t.negotiationId),
  ],
);

/**
 * S7.1 supply commitments: the economic promise behind an ACCEPTED
 * negotiation. One unit (price x 1) + one capacity unit per accept, locked
 * at accept time and consumed exactly once by the first downstream S5
 * reservation — never double-counted, never silently dropped.
 */
export const supplyCommitments = pgTable(
  "supply_commitments",
  {
    id: text("id").primaryKey(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    negotiationId: text("negotiation_id")
      .notNull()
      .references(() => negotiations.id, { onDelete: "cascade" }),
    partnerId: text("partner_id")
      .notNull()
      .references(() => partners.id, { onDelete: "cascade" }),
    partnerTermsId: text("partner_terms_id")
      .notNull()
      .references(() => partnerTerms.id, { onDelete: "cascade" }),
    amountMicroUsdc: bigint("amount_micro_usdc", { mode: "bigint" }).notNull(),
    state: commitmentStateEnum("state").notNull().default("ACTIVE"),
    consumedByOutcomeId: text("consumed_by_outcome_id"),
    consumedByReservationId: text("consumed_by_reservation_id"),
    releasedReason: text("released_reason"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("supply_commitments_negotiation_unique").on(t.negotiationId),
    index("supply_commitments_campaign_idx").on(t.campaignId),
    index("supply_commitments_terms_idx").on(t.partnerTermsId),
  ],
);

export type DbUserPersona = typeof userPersonas.$inferSelect;
export type DbUser = typeof users.$inferSelect;
export type DbSupplyCommitment = typeof supplyCommitments.$inferSelect;
export type DbNegotiation = typeof negotiations.$inferSelect;
export type DbNegotiationDecision = typeof negotiationDecisions.$inferSelect;
export type DbMarketDecision = typeof marketDecisions.$inferSelect;
export type DbReservation = typeof spendReservations.$inferSelect;
export type DbPayout = typeof payouts.$inferSelect;
export type DbAttributionSession = typeof attributionSessions.$inferSelect;
export type DbCheckoutIntent = typeof checkoutIntents.$inferSelect;
export type DbOutcome = typeof outcomes.$inferSelect;
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
