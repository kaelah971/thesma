import { and, count, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { creatorFollows, userPersonas, users } from "../db/schema";
import { normalizeHandle } from "./personas";
import { getPartnerByUserId } from "./partners";
import { listCreatorLiveCampaigns, type CreatorLiveCampaignCard } from "./markets";
import type { MarketStore } from "./campaignStore";

/**
 * Public creator profiles + follow v1.
 *
 * Proof > follower counts. Everything public here derives from existing
 * participation truth (persona, joins, referrals, outcomes, payouts,
 * markets). The public payload is a deliberately shaped DTO — raw user,
 * wallet, session, and audit rows never leave the server.
 *
 * Opt-in rule: a creator is public when they completed creator onboarding
 * AND set a handle (the handle was always presented as reserving the
 * public profile). No separate visibility flag needed.
 */

export interface PersonaRow {
  userId: string;
  persona: string;
  handle: string | null;
  bio: string | null;
  category: string | null;
  onboardingCompletedAt: Date | null;
}

export interface ProfileUser {
  id: string;
  name: string | null;
  createdAt: Date;
}

/** Sealed data source so profile resolution is unit-testable without a DB. */
export interface ProfileSource {
  findPersonaByHandle(handle: string): Promise<PersonaRow | null>;
  getUser(userId: string): Promise<ProfileUser | null>;
}

export const drizzleProfileSource: ProfileSource = {
  async findPersonaByHandle(handle: string) {
    const normalized = normalizeHandle(handle);
    if (!normalized) return null;
    const db = getDb();
    const [row] = await db.select().from(userPersonas).where(eq(userPersonas.handle, normalized)).limit(1).catch(() => []);
    return (row as PersonaRow | undefined) ?? null;
  },
  async getUser(userId: string) {
    const db = getDb();
    const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1).catch(() => []);
    return row ? { id: row.id, name: row.name, createdAt: row.createdAt } : null;
  },
};

/** A persona row is publicly visible only as a finished creator profile. */
export function isPublicCreatorIdentity(row: PersonaRow | null): boolean {
  if (!row) return false;
  if (row.persona !== "CREATOR") return false;
  if (!row.handle || !normalizeHandle(row.handle)) return false;
  if (!row.onboardingCompletedAt) return false;
  return true;
}

export interface CompletedCollaboration {
  campaignId: string;
  workspaceName: string;
  objective: string;
  verifiedOutcomes: number;
  settledOutcomes: number;
  settledPayoutMicroUsdc: string;
  proofPath: string | null;
}

export interface PublicCreatorProfile {
  displayName: string;
  handle: string;
  bio: string | null;
  category: string | null;
  joinedAt: string;
  followerCount: number;
  isFollowing: boolean;
  metrics: {
    verifiedOutcomes: number;
    settledCollaborations: number;
    activeCampaigns: number;
    completedCampaigns: number;
    verificationRate: number | null;
  };
  live: CreatorLiveCampaignCard[];
  history: CompletedCollaboration[];
}

/** Follow storage sealed for unit tests; drizzle below, memory in tests. */
export interface FollowStore {
  follow(followerUserId: string, creatorUserId: string): Promise<{ following: boolean }>;
  unfollow(followerUserId: string, creatorUserId: string): Promise<{ following: boolean }>;
  isFollowing(followerUserId: string, creatorUserId: string): Promise<boolean>;
  followerCount(creatorUserId: string): Promise<number>;
  followingList(followerUserId: string): Promise<string[]>;
}

export function validateFollowPair(followerUserId: string, creatorUserId: string): void {
  if (!followerUserId || !creatorUserId) {
    throw Object.assign(new Error("Both users are required"), { status: 400, code: "BAD_REQUEST" });
  }
  if (followerUserId === creatorUserId) {
    throw Object.assign(new Error("You cannot follow yourself"), { status: 400, code: "BAD_REQUEST" });
  }
}

export function createMemoryFollowStore(): FollowStore & { size(): number } {
  const pairs = new Set<string>();
  const key = (f: string, c: string) => `${f}→${c}`;
  const countFor = (c: string) => [...pairs].filter((k) => k.endsWith(`→${c}`)).length;
  return {
    size: () => pairs.size,
    async follow(followerUserId: string, creatorUserId: string) {
      validateFollowPair(followerUserId, creatorUserId);
      pairs.add(key(followerUserId, creatorUserId));
      return { following: true };
    },
    async unfollow(followerUserId: string, creatorUserId: string) {
      validateFollowPair(followerUserId, creatorUserId);
      pairs.delete(key(followerUserId, creatorUserId));
      return { following: false };
    },
    async isFollowing(followerUserId: string, creatorUserId: string) {
      if (followerUserId === creatorUserId) return false;
      return pairs.has(key(followerUserId, creatorUserId));
    },
    async followerCount(creatorUserId: string) {
      return countFor(creatorUserId);
    },
    async followingList(followerUserId: string) {
      return [...pairs].filter((k) => k.startsWith(`${followerUserId}→`)).map((k) => k.slice(followerUserId.length + 1));
    },
  };
}

export interface ProfileDeps {
  store: MarketStore;
  source?: ProfileSource;
  follows?: FollowStore;
  viewerUserId?: string | null;
}

/** Production follow storage over the creator_follows table. */
export function createDrizzleFollowStore(): FollowStore {
  return {
    async follow(followerUserId: string, creatorUserId: string) {
      validateFollowPair(followerUserId, creatorUserId);
      const db = getDb();
      await db
        .insert(creatorFollows)
        .values({ followerUserId, creatorUserId })
        .onConflictDoNothing();
      return { following: true };
    },
    async unfollow(followerUserId: string, creatorUserId: string) {
      validateFollowPair(followerUserId, creatorUserId);
      const db = getDb();
      await db
        .delete(creatorFollows)
        .where(
          and(
            eq(creatorFollows.followerUserId, followerUserId),
            eq(creatorFollows.creatorUserId, creatorUserId),
          ),
        );
      return { following: false };
    },
    async isFollowing(followerUserId: string, creatorUserId: string) {
      if (!followerUserId || followerUserId === creatorUserId) return false;
      const db = getDb();
      const [row] = await db
        .select({ followerUserId: creatorFollows.followerUserId })
        .from(creatorFollows)
        .where(
          and(
            eq(creatorFollows.followerUserId, followerUserId),
            eq(creatorFollows.creatorUserId, creatorUserId),
          ),
        )
        .limit(1);
      return Boolean(row);
    },
    async followerCount(creatorUserId: string) {
      const db = getDb();
      const [row] = await db
        .select({ n: count() })
        .from(creatorFollows)
        .where(eq(creatorFollows.creatorUserId, creatorUserId));
      return row?.n ?? 0;
    },
    async followingList(followerUserId: string) {
      const db = getDb();
      const rows = await db
        .select({ creatorUserId: creatorFollows.creatorUserId })
        .from(creatorFollows)
        .where(eq(creatorFollows.followerUserId, followerUserId));
      return rows.map((r) => r.creatorUserId);
    },
  };
}

/**
 * Resolves /@handle to a public-safe profile, or null (→ 404) for unknown,
 * unfinished, non-creator, or handle-less rows. Completed history only
 * admits campaigns backed by real VERIFIED outcomes; settled counts come
 * from real reconciled payouts.
 */
export async function getPublicCreatorProfile(
  rawHandle: string,
  deps: ProfileDeps,
): Promise<PublicCreatorProfile | null> {
  const handle = normalizeHandle(rawHandle);
  if (!handle) return null;
  const source = deps.source ?? drizzleProfileSource;
  const row = await source.findPersonaByHandle(handle).catch(() => null);
  if (!isPublicCreatorIdentity(row)) return null;
  const user = await source.getUser(row!.userId).catch(() => null);
  if (!user) return null;

  const partner = await getPartnerByUserId(user.id).catch(() => null);
  const partnerId = partner?.id ?? null;
  const live = partnerId
    ? await listCreatorLiveCampaigns(
        { store: deps.store, audit: async () => ({}) },
        { partnerId },
      ).then((r) => r.campaigns).catch(() => [])
    : [];

  // Proof-backed history: VERIFIED outcomes grouped by campaign.
  const history: CompletedCollaboration[] = [];
  let verifiedTotal = 0;
  const settledCampaigns = new Set<string>();
  if (partnerId) {
    const verified = await deps.store.listOutcomesByStatus("VERIFIED", 200).catch(() => []);
    const mine = verified.filter((o) => o.partnerId === partnerId);
    verifiedTotal = mine.length;
    const byCampaign = new Map<string, typeof mine>();
    for (const o of mine) {
      const list = byCampaign.get(o.campaignId) ?? [];
      list.push(o);
      byCampaign.set(o.campaignId, list);
    }
    for (const [campaignId, items] of byCampaign) {
      const campaign = await deps.store.getCampaign(campaignId).catch(() => null);
      if (!campaign) continue;
      // Only publicly visible campaigns belong on a public profile.
      const current = await deps.store.getCurrentVersion(campaignId).catch(() => null);
      if (!current || current.marketVisibility !== "PUBLIC") continue;
      const workspace = await deps.store.getWorkspace(campaign.workspaceId).catch(() => null);
      let settledCount = 0;
      let settledSum = 0n;
      for (const o of items) {
        const payout = await deps.store.getPayoutByOutcome(o.id).catch(() => null);
        if (payout && payout.state === "SETTLED") {
          settledCount += 1;
          settledSum += payout.amountMicroUsdc;
          settledCampaigns.add(campaignId);
        }
      }
      const market = await deps.store.getMarket(campaignId).catch(() => null);
      history.push({
        campaignId,
        workspaceName: workspace?.name ?? "Workspace",
        objective: current.intentText,
        verifiedOutcomes: items.length,
        settledOutcomes: settledCount,
        settledPayoutMicroUsdc: settledSum.toString(),
        proofPath: market ? `/markets/${campaignId}` : null,
      });
    }
    history.sort((a, b) => b.verifiedOutcomes - a.verifiedOutcomes);
  }

  const follows = deps.follows ?? null;
  const [followerCount, isFollowing] = follows
    ? await Promise.all([
        follows.followerCount(user.id).catch(() => 0),
        deps.viewerUserId ? follows.isFollowing(deps.viewerUserId, user.id).catch(() => false) : Promise.resolve(false),
      ])
    : [0, false];

  // Verification rate is withheld: outcomes carry no honest attempt
  // denominator, and inventing one would fabricate precision.
  return {
    displayName: user.name ?? `@${handle}`,
    handle,
    bio: row!.bio,
    category: row!.category,
    joinedAt: user.createdAt.toISOString(),
    followerCount,
    isFollowing,
    metrics: {
      verifiedOutcomes: verifiedTotal,
      settledCollaborations: settledCampaigns.size,
      activeCampaigns: live.length,
      completedCampaigns: history.filter((h) => !live.some((l) => l.campaignId === h.campaignId)).length,
      verificationRate: null,
    },
    live,
    history,
  };
}
