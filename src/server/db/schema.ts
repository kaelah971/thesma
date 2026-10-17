import {
  index,
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

export type DbUser = typeof users.$inferSelect;
export type DbWorkspace = typeof workspaces.$inferSelect;
export type DbWorkspaceMember = typeof workspaceMembers.$inferSelect;
export type DbPartner = typeof partners.$inferSelect;
export type DbSession = typeof sessions.$inferSelect;
export type DbAuditEvent = typeof auditEvents.$inferSelect;
