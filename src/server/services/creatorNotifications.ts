import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/client";
import { creatorNotifications } from "../db/schema";
import { newId } from "../auth/session";

/**
 * Durable creator notification inbox (background Scout runs).
 * One row per meaningful event — repeat background runs stay quiet via
 * deterministic dedupe keys; the DB unique index is the second backstop.
 * No email/push: inbox only.
 */

export type CreatorAlertType =
  | "NEW_MATCH"
  | "NEW_MATCH_REQUIRES_REVIEW"
  | "AUTO_JOINED"
  | "AUTO_JOIN_REFUSED"
  | "BOUNTY_CHANGED"
  | "CAMPAIGN_CLOSING_SOON"
  | "VERIFICATION_DROP"
  | "PAYOUT_SETTLED";

export interface NewCreatorNotification {
  type: CreatorAlertType;
  campaignId: string | null;
  title: string;
  message: string;
  dedupeKey: string;
  metadataJson?: Record<string, unknown>;
}

export interface StoredCreatorNotification {
  id: string;
  creatorUserId: string;
  type: CreatorAlertType;
  campaignId: string | null;
  title: string;
  message: string;
  dedupeKey: string;
  metadataJson: Record<string, unknown>;
  createdAt: Date;
  readAt: Date | null;
}

export interface NotificationStore {
  listForCreator(creatorUserId: string, limit?: number): Promise<StoredCreatorNotification[]>;
  unreadCount(creatorUserId: string): Promise<number>;
  insertIfAbsent(creatorUserId: string, n: NewCreatorNotification): Promise<{ inserted: boolean }>;
  /** Ownership enforced: only the owner's row can flip. */
  markRead(creatorUserId: string, id: string): Promise<boolean>;
  markAllRead(creatorUserId: string): Promise<number>;
}

function toStored(row: typeof creatorNotifications.$inferSelect): StoredCreatorNotification {
  return {
    id: row.id,
    creatorUserId: row.creatorUserId,
    type: row.type as CreatorAlertType,
    campaignId: row.campaignId,
    title: row.title,
    message: row.message,
    dedupeKey: row.dedupeKey,
    metadataJson: (row.metadataJson ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt,
    readAt: row.readAt,
  };
}

export function createDrizzleNotificationStore(): NotificationStore {
  return {
    async listForCreator(creatorUserId, limit = 100) {
      const db = getDb();
      const rows = await db
        .select()
        .from(creatorNotifications)
        .where(eq(creatorNotifications.creatorUserId, creatorUserId))
        .orderBy(desc(creatorNotifications.createdAt))
        .limit(Math.min(Math.max(limit, 1), 200));
      return rows.map(toStored);
    },
    async unreadCount(creatorUserId) {
      const db = getDb();
      const rows = await db
        .select({ id: creatorNotifications.id })
        .from(creatorNotifications)
        .where(
          and(eq(creatorNotifications.creatorUserId, creatorUserId), isNull(creatorNotifications.readAt)),
        );
      return rows.length;
    },
    async insertIfAbsent(creatorUserId, n) {
      const db = getDb();
      const rows = await db
        .insert(creatorNotifications)
        .values({
          id: newId(),
          creatorUserId,
          type: n.type,
          campaignId: n.campaignId,
          title: n.title,
          message: n.message,
          dedupeKey: n.dedupeKey,
          metadataJson: n.metadataJson ?? {},
        })
        .onConflictDoNothing({
          target: [creatorNotifications.creatorUserId, creatorNotifications.dedupeKey],
        })
        .returning({ id: creatorNotifications.id });
      return { inserted: rows.length > 0 };
    },
    async markRead(creatorUserId, id) {
      const db = getDb();
      const now = new Date();
      const rows = await db
        .update(creatorNotifications)
        .set({ readAt: now })
        .where(
          and(
            eq(creatorNotifications.id, id),
            eq(creatorNotifications.creatorUserId, creatorUserId),
            isNull(creatorNotifications.readAt),
          ),
        )
        .returning({ id: creatorNotifications.id });
      return rows.length > 0;
    },
    async markAllRead(creatorUserId) {
      const db = getDb();
      const rows = await db
        .update(creatorNotifications)
        .set({ readAt: new Date() })
        .where(
          and(eq(creatorNotifications.creatorUserId, creatorUserId), isNull(creatorNotifications.readAt)),
        )
        .returning({ id: creatorNotifications.id });
      return rows.length;
    },
  };
}

export function createMemoryNotificationStore(): NotificationStore & { size(): number } {
  const rows = new Map<string, StoredCreatorNotification>();
  const key = (creatorUserId: string, dedupeKey: string) => `${creatorUserId}:${dedupeKey}`;
  return {
    size: () => rows.size,
    async listForCreator(creatorUserId, limit = 100) {
      return [...rows.values()]
        .filter((r) => r.creatorUserId === creatorUserId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, Math.min(Math.max(limit, 1), 200));
    },
    async unreadCount(creatorUserId) {
      let n = 0;
      for (const r of rows.values()) if (r.creatorUserId === creatorUserId && !r.readAt) n += 1;
      return n;
    },
    async insertIfAbsent(creatorUserId, n) {
      const k = key(creatorUserId, n.dedupeKey);
      if (rows.has(k)) return { inserted: false };
      rows.set(k, {
        id: newId(),
        creatorUserId,
        type: n.type,
        campaignId: n.campaignId,
        title: n.title,
        message: n.message,
        dedupeKey: n.dedupeKey,
        metadataJson: n.metadataJson ?? {},
        createdAt: new Date(),
        readAt: null,
      });
      return { inserted: true };
    },
    async markRead(creatorUserId, id) {
      for (const r of rows.values()) {
        if (r.id === id) {
          if (r.creatorUserId !== creatorUserId || r.readAt) return false;
          r.readAt = new Date();
          return true;
        }
      }
      return false;
    },
    async markAllRead(creatorUserId) {
      let n = 0;
      for (const r of rows.values()) {
        if (r.creatorUserId === creatorUserId && !r.readAt) {
          r.readAt = new Date();
          n += 1;
        }
      }
      return n;
    },
  };
}

/* ---------------- Deterministic dedupe keys (event truth, not run time) ---------------- */

export function closingBucket(msUntilDeadline: number | null): "24h" | "72h" | null {
  if (msUntilDeadline === null || msUntilDeadline <= 0) return null;
  if (msUntilDeadline <= 24 * 3_600_000) return "24h";
  if (msUntilDeadline <= 72 * 3_600_000) return "72h";
  return null;
}

export function isoWeekBucket(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const first = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - first.getTime()) / 86_400_000 - 3 + ((first.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export const dedupeKeyFor = {
  newMatch: (campaignId: string) => `nm:${campaignId}`,
  review: (campaignId: string, rule: string) => `nmr:${campaignId}:${rule}`,
  autoJoined: (campaignId: string, referralCode: string) => `aj:${campaignId}:${referralCode}`,
  autoJoinRefused: (campaignId: string, rule: string) => `ajr:${campaignId}:${rule}`,
  bountyChanged: (campaignId: string, newBountyMicroUsdc: string) => `bc:${campaignId}:${newBountyMicroUsdc}`,
  closingSoon: (campaignId: string, bucket: string) => `cs:${campaignId}:${bucket}`,
  verificationDrop: (weekBucket: string) => `vd:${weekBucket}`,
  payoutSettled: (payoutId: string) => `ps:${payoutId}`,
};

/* ---------------- Refusal alert quality (no spam) ---------------- */

/**
 * AUTO_JOIN_REFUSED only surfaces when useful: Scout genuinely recommended
 * the campaign but ONE creator policy blocked autonomous joining. Blanket
 * rejections (category blocks, ineligibility, non-recommendations, join
 * errors) stay silent — they are already visible on the Scout board.
 */
const USEFUL_REFUSAL_RULES = new Set(["MIN_BOUNTY", "MAX_ACTIVE", "RATE_LIMITED"]);

export function isUsefulRefusal(scoutDecision: string, rule: string): boolean {
  return scoutDecision === "RECOMMEND" && USEFUL_REFUSAL_RULES.has(rule);
}

export function refusalMessage(params: {
  workspaceName: string;
  bountyMicroUsdc: string;
  rule: string;
  minBountyMicroUsdc: string;
  maxActiveCampaigns: number | null;
  maxJoinsPerDay: number | null;
  formatUsdc: (micro: string) => string;
}): string {
  const p = params;
  if (p.rule === "MIN_BOUNTY") {
    return (
      `Recommended, but below your ${p.formatUsdc(p.minBountyMicroUsdc)} USDC minimum ` +
      `(${p.workspaceName} offers ${p.formatUsdc(p.bountyMicroUsdc)} USDC per verified outcome).`
    );
  }
  if (p.rule === "MAX_ACTIVE") {
    return (
      `Recommended, but you already reached your active-campaign limit` +
      `${p.maxActiveCampaigns !== null ? ` (${p.maxActiveCampaigns})` : ""} — ${p.workspaceName} is waiting.`
    );
  }
  return (
    `Recommended, but you already reached your daily join limit` +
    `${p.maxJoinsPerDay !== null ? ` (${p.maxJoinsPerDay}/day)` : ""} — ${p.workspaceName} is waiting.`
  );
}
