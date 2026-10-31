import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { auditEvents } from "../db/schema";
import type { AuditSink } from "./campaignStore";

/**
 * Server-issued company-wallet registration challenges.
 *
 * A challenge binds (user, workspace, wallet) to a random nonce with a short
 * expiry and is consumed exactly once. The typed-data signature then proves
 * key control over that exact binding — no replay across workspaces, wallets
 * or users, and no silent reuse after expiry.
 *
 * Persistence reuses the existing audit_events table (no migration):
 * issuance and consumption are audit rows; no private material is stored.
 */

export const CHALLENGE_TTL_MS = 10 * 60 * 1000;

export interface CompanyWalletChallenge {
  nonce: string;
  workspaceId: string;
  wallet: string;
  userId: string;
  issuedAt: string;
  expiresAt: string;
}

const ISSUED = "workspace.company_wallet_challenge_issued";
const CONSUMED = "workspace.company_wallet_challenge_consumed";

export interface CompanyWalletChallengeStore {
  issue(c: CompanyWalletChallenge): Promise<void>;
  find(nonce: string): Promise<CompanyWalletChallenge | null>;
  /** Marks consumed. Returns false when already consumed (single-use gate). */
  consume(nonce: string, workspaceId: string): Promise<boolean>;
}

function isChallenge(value: unknown): value is CompanyWalletChallenge {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.nonce === "string" &&
    typeof c.workspaceId === "string" &&
    typeof c.wallet === "string" &&
    typeof c.userId === "string" &&
    typeof c.issuedAt === "string" &&
    typeof c.expiresAt === "string"
  );
}

/** In-memory implementation (unit tests). */
export function createMemoryCompanyWalletChallengeStore(): CompanyWalletChallengeStore {
  const issued = new Map<string, CompanyWalletChallenge>();
  const consumed = new Set<string>();
  return {
    async issue(c) {
      issued.set(c.nonce, { ...c });
    },
    async find(nonce) {
      return issued.get(nonce) ?? null;
    },
    async consume(nonce) {
      if (consumed.has(nonce)) return false;
      if (!issued.has(nonce)) return false;
      consumed.add(nonce);
      return true;
    },
  };
}

/**
 * Production implementation on the existing audit_events table.
 * Concurrent double-consume of the same nonce resolves to the same wallet
 * (the nonce binds exactly one address), so the worst case is a harmless
 * idempotent re-registration — never a different address.
 */
export function createDrizzleCompanyWalletChallengeStore(audit: AuditSink): CompanyWalletChallengeStore {
  return {
    async issue(c) {
      await audit({
        actorType: "USER",
        actorId: c.userId,
        workspaceId: c.workspaceId,
        action: ISSUED,
        targetType: "workspace",
        targetId: c.workspaceId,
        metadata: { ...c },
      });
    },
    async find(nonce) {
      const db = getDb();
      const [row] = await db
        .select({ metadata: auditEvents.metadata })
        .from(auditEvents)
        .where(and(eq(auditEvents.action, ISSUED), sql`${auditEvents.metadata}->>'nonce' = ${nonce}`))
        .orderBy(desc(auditEvents.createdAt))
        .limit(1);
      const meta = row?.metadata as unknown;
      return isChallenge(meta) ? meta : null;
    },
    async consume(nonce, workspaceId) {
      const db = getDb();
      const existing = await db
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, CONSUMED),
            eq(auditEvents.workspaceId, workspaceId),
            sql`${auditEvents.metadata}->>'nonce' = ${nonce}`,
          ),
        )
        .limit(1);
      if (existing.length > 0) return false;
      await audit({
        actorType: "USER",
        actorId: null,
        workspaceId,
        action: CONSUMED,
        targetType: "workspace",
        targetId: workspaceId,
        metadata: { nonce },
      });
      return true;
    },
  };
}
