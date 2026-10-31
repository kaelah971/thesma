import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { auditEvents } from "../db/schema";
import type { AuditSink } from "./campaignStore";

/**
 * Server-issued company-wallet registration challenges, two-phase:
 * ISSUED → PROVED (signature verified, signer recovered) → CONSUMED
 * (workspace updated). The challenge binds (user, workspace) only — the
 * cryptographic signer IS the identity, recovered server-side, so no
 * client-selected address can mismatch. Replay, cross-workspace and
 * cross-user reuse all fail closed.
 *
 * Persistence reuses the existing audit_events table (no migration):
 * issuance, proof and consumption are audit rows; no private material,
 * no signatures, and no nonces are stored outside these rows.
 */

export const CHALLENGE_TTL_MS = 10 * 60 * 1000;

export type ChallengeStatus = "ISSUED" | "PROVED" | "CONSUMED";

export interface CompanyWalletChallenge {
  nonce: string;
  workspaceId: string;
  userId: string;
  issuedAt: string;
  expiresAt: string;
  status: ChallengeStatus;
  /** Canonical recovered signer once PROVED; null before. */
  provedWallet: string | null;
}

const ISSUED = "workspace.company_wallet_challenge_issued";
const PROVED = "workspace.company_wallet_challenge_proved";
const CONSUMED = "workspace.company_wallet_challenge_consumed";

export interface CompanyWalletChallengeStore {
  issue(c: { nonce: string; workspaceId: string; userId: string; issuedAt: string; expiresAt: string }): Promise<void>;
  find(nonce: string): Promise<CompanyWalletChallenge | null>;
  /** Records a verified proof. Succeeds from ISSUED or PROVED (re-prove); never from CONSUMED or unknown. */
  prove(nonce: string, workspaceId: string, provedWallet: string): Promise<boolean>;
  /** Marks consumed. Returns false unless currently PROVED (single-use gate). */
  consume(nonce: string, workspaceId: string): Promise<boolean>;
}

function isIssued(value: unknown): value is { nonce: string; workspaceId: string; userId: string; issuedAt: string; expiresAt: string } {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.nonce === "string" &&
    typeof c.workspaceId === "string" &&
    typeof c.userId === "string" &&
    typeof c.issuedAt === "string" &&
    typeof c.expiresAt === "string"
  );
}

/** In-memory implementation (unit tests). */
export function createMemoryCompanyWalletChallengeStore(): CompanyWalletChallengeStore {
  const issued = new Map<string, { nonce: string; workspaceId: string; userId: string; issuedAt: string; expiresAt: string }>();
  const proved = new Map<string, string>();
  const consumed = new Set<string>();
  return {
    async issue(c) {
      issued.set(c.nonce, { ...c });
    },
    async find(nonce) {
      const base = issued.get(nonce);
      if (!base) return null;
      if (consumed.has(nonce)) return { ...base, status: "CONSUMED", provedWallet: proved.get(nonce) ?? null };
      const wallet = proved.get(nonce);
      if (wallet !== undefined) return { ...base, status: "PROVED", provedWallet: wallet };
      return { ...base, status: "ISSUED", provedWallet: null };
    },
    async prove(nonce, workspaceId, provedWallet) {
      const base = issued.get(nonce);
      if (!base || base.workspaceId !== workspaceId || consumed.has(nonce)) return false;
      proved.set(nonce, provedWallet);
      return true;
    },
    async consume(nonce, workspaceId) {
      const base = issued.get(nonce);
      if (!base || base.workspaceId !== workspaceId || consumed.has(nonce)) return false;
      if (!proved.has(nonce)) return false;
      consumed.add(nonce);
      return true;
    },
  };
}

/**
 * Production implementation on the existing audit_events table.
 * prove() records the verified signer; consume() requires a prior proof.
 * A nonce can never register two different wallets: consume requires the
 * stored proof, and registration uses ONLY that stored address.
 */
export function createDrizzleCompanyWalletChallengeStore(audit: AuditSink): CompanyWalletChallengeStore {
  async function hasAction(nonce: string, workspaceId: string, action: string): Promise<boolean> {
    const db = getDb();
    const rows = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, action),
          eq(auditEvents.workspaceId, workspaceId),
          sql`${auditEvents.metadata}->>'nonce' = ${nonce}`,
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

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
        .select({ metadata: auditEvents.metadata, workspaceId: auditEvents.workspaceId })
        .from(auditEvents)
        .where(and(eq(auditEvents.action, ISSUED), sql`${auditEvents.metadata}->>'nonce' = ${nonce}`))
        .orderBy(desc(auditEvents.createdAt))
        .limit(1);
      const meta = row?.metadata as unknown;
      if (!isIssued(meta)) return null;
      const workspaceId = meta.workspaceId;
      if (await hasAction(nonce, workspaceId, CONSUMED)) {
        const [proof] = await db
          .select({ metadata: auditEvents.metadata })
          .from(auditEvents)
          .where(and(eq(auditEvents.action, PROVED), sql`${auditEvents.metadata}->>'nonce' = ${nonce}`))
          .orderBy(desc(auditEvents.createdAt))
          .limit(1);
        const wallet = (proof?.metadata as { provedWallet?: unknown } | null)?.provedWallet;
        return { ...meta, status: "CONSUMED", provedWallet: typeof wallet === "string" ? wallet : null };
      }
      const [proof] = await db
        .select({ metadata: auditEvents.metadata })
        .from(auditEvents)
        .where(and(eq(auditEvents.action, PROVED), sql`${auditEvents.metadata}->>'nonce' = ${nonce}`))
        .orderBy(desc(auditEvents.createdAt))
        .limit(1);
      const wallet = (proof?.metadata as { provedWallet?: unknown } | null)?.provedWallet;
      if (typeof wallet === "string" && wallet) return { ...meta, status: "PROVED", provedWallet: wallet };
      return { ...meta, status: "ISSUED", provedWallet: null };
    },
    async prove(nonce, workspaceId, provedWallet) {
      const current = await this.find(nonce);
      if (!current || current.workspaceId !== workspaceId) return false;
      if (current.status === "CONSUMED") return false;
      await audit({
        actorType: "USER",
        actorId: current.userId,
        workspaceId,
        action: PROVED,
        targetType: "workspace",
        targetId: workspaceId,
        metadata: { nonce, provedWallet },
      });
      return true;
    },
    async consume(nonce, workspaceId) {
      const current = await this.find(nonce);
      if (!current || current.workspaceId !== workspaceId) return false;
      if (current.status !== "PROVED") return false;
      await audit({
        actorType: "USER",
        actorId: current.userId,
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
