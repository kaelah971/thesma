import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { partners } from "../db/schema";
import { newId } from "../auth/session";
import type { PartnerRules } from "../domain/types";
import { recordAuditEvent } from "./audit";

export interface PartnerUpsert {
  payoutWallet?: string | null;
  categories?: string[];
  rulesJson?: PartnerRules;
}

function normalizeRules(rules: PartnerRules | undefined): PartnerRules {
  return {
    minBountyMicroUSDC: rules?.minBountyMicroUSDC ?? null,
    allowedCategories: rules?.allowedCategories ?? [],
    blockedCategories: rules?.blockedCategories ?? [],
    maxActiveCampaigns: rules?.maxActiveCampaigns ?? null,
    autoJoin: rules?.autoJoin ?? false,
    autoNegotiate: rules?.autoNegotiate ?? false,
    maxAllocation: rules?.maxAllocation ?? null,
    minScoutConfidence: rules?.minScoutConfidence ?? "MEDIUM",
    maxAutoJoinsPerDay: rules?.maxAutoJoinsPerDay ?? null,
  };
}

/** Pure ownership check — the caller's userId must equal the profile's userId. */
export function isPartnerOwner(profileUserId: string, callerUserId: string): boolean {
  return profileUserId === callerUserId;
}

/** One Partner profile per user (partners.userId unique). */
export async function getPartnerByUserId(userId: string) {
  const db = getDb();
  const [row] = await db.select().from(partners).where(eq(partners.userId, userId)).limit(1);
  return row ?? null;
}

export async function createPartnerProfile(params: { userId: string } & PartnerUpsert) {
  const db = getDb();
  const existing = await getPartnerByUserId(params.userId);
  if (existing) {
    throw Object.assign(new Error("Partner profile already exists"), { status: 409, code: "CONFLICT" });
  }
  const id = newId();
  const [row] = await db
    .insert(partners)
    .values({
      id,
      userId: params.userId,
      payoutWallet: params.payoutWallet ?? null,
      categories: params.categories ?? [],
      rulesJson: normalizeRules(params.rulesJson),
    })
    .returning();

  await recordAuditEvent(db, {
    actorType: "USER",
    actorId: params.userId,
    partnerId: id,
    action: "partner.created",
    targetType: "partner",
    targetId: id,
  });

  return row;
}

export async function updatePartnerProfile(params: { userId: string } & PartnerUpsert) {
  const db = getDb();
  const existing = await getPartnerByUserId(params.userId);
  if (!existing) {
    throw Object.assign(new Error("Partner profile not found"), { status: 404, code: "NOT_FOUND" });
  }
  // Ownership: the profile's userId must equal the caller — enforced by lookup above.
  const mergedRules = params.rulesJson
    ? { ...normalizeRules((existing.rulesJson as PartnerRules) ?? {}), ...params.rulesJson }
    : existing.rulesJson;
  const [row] = await db
    .update(partners)
    .set({
      payoutWallet: params.payoutWallet !== undefined ? params.payoutWallet : existing.payoutWallet,
      categories: params.categories ?? existing.categories,
      rulesJson: mergedRules,
      updatedAt: new Date(),
    })
    .where(eq(partners.id, existing.id))
    .returning();

  await recordAuditEvent(db, {
    actorType: "USER",
    actorId: params.userId,
    partnerId: existing.id,
    action: "partner.updated",
    targetType: "partner",
    targetId: existing.id,
  });

  return row;
}
