import { describe, expect, it } from "vitest";
import {
  createMemoryFollowStore,
  getPublicCreatorProfile,
  isPublicCreatorIdentity,
  validateFollowPair,
  type ProfileSource,
} from "@/server/services/creatorProfiles";

const personaBase = {
  userId: "u-creator",
  persona: "CREATOR",
  handle: "endurance",
  bio: "Fitness deals",
  category: "Fitness",
  onboardingCompletedAt: new Date("2026-01-01T00:00:00.000Z"),
};

function sourceWith(overrides: Record<string, unknown> = {}): ProfileSource {
  const persona = { ...personaBase, ...overrides };
  return {
    async findPersonaByHandle(handle: string) {
      return handle === "endurance" ? { ...persona } : null;
    },
    async getUser() {
      return { id: "u-creator", name: "Endurance", createdAt: new Date("2025-12-01T00:00:00.000Z") };
    },
  };
}

const emptyStore = {
  async listOutcomesByStatus() {
    return [];
  },
} as never;

describe("public identity gating", () => {
  it("publishes finished creator profiles with handles", () => {
    expect(isPublicCreatorIdentity({ ...personaBase })).toBe(true);
  });

  it("withholds unfinished, non-creator, handle-less and unknown rows", () => {
    expect(isPublicCreatorIdentity(null)).toBe(false);
    expect(isPublicCreatorIdentity({ ...personaBase, persona: "CUSTOMER" })).toBe(false);
    expect(isPublicCreatorIdentity({ ...personaBase, handle: null })).toBe(false);
    expect(isPublicCreatorIdentity({ ...personaBase, handle: "nope!" })).toBe(false);
    expect(isPublicCreatorIdentity({ ...personaBase, onboardingCompletedAt: null })).toBe(false);
  });

  it("resolves by handle and 404s unknown handles", async () => {
    const ok = await getPublicCreatorProfile("endurance", {
      store: emptyStore,
      source: sourceWith(),
      follows: createMemoryFollowStore(),
    });
    expect(ok?.handle).toBe("endurance");
    expect(ok?.displayName).toBe("Endurance");
    const missing = await getPublicCreatorProfile("ghost", {
      store: emptyStore,
      source: sourceWith(),
      follows: createMemoryFollowStore(),
    });
    expect(missing).toBeNull();
    const malformed = await getPublicCreatorProfile("not a handle!!", {
      store: emptyStore,
      source: sourceWith(),
      follows: createMemoryFollowStore(),
    });
    expect(malformed).toBeNull();
  });
});

describe("public-safe DTO", () => {
  it("exposes identity and proof, never private fields", async () => {
    const profile = await getPublicCreatorProfile("@Endurance", {
      store: emptyStore,
      source: sourceWith(),
      follows: createMemoryFollowStore(),
      viewerUserId: "u-fan",
    });
    expect(profile).not.toBeNull();
    const serialized = JSON.stringify(profile);
    expect(serialized).not.toMatch(/@example|password|wallet|token|session|secret/i);
    expect(profile).not.toHaveProperty("email");
    expect(profile).not.toHaveProperty("userId");
    expect(profile).not.toHaveProperty("payoutWallet");
    expect(profile?.bio).toBe("Fitness deals");
    expect(profile?.category).toBe("Fitness");
    expect(profile?.metrics.verifiedOutcomes).toBe(0);
    expect(profile?.metrics.verificationRate).toBeNull();
    expect(profile?.live).toEqual([]);
    expect(profile?.history).toEqual([]);
    expect(profile?.isFollowing).toBe(false);
    expect(profile?.followerCount).toBe(0);
  });
});

describe("follow store", () => {
  it("follows idempotently and counts exactly", async () => {
    const follows = createMemoryFollowStore();
    await follows.follow("u-fan", "u-creator");
    await follows.follow("u-fan", "u-creator");
    expect(await follows.isFollowing("u-fan", "u-creator")).toBe(true);
    expect(await follows.followerCount("u-creator")).toBe(1);
    expect(follows.size()).toBe(1);
    await follows.follow("u-fan2", "u-creator");
    expect(await follows.followerCount("u-creator")).toBe(2);
  });

  it("unfollows idempotently", async () => {
    const follows = createMemoryFollowStore();
    await follows.unfollow("u-fan", "u-creator");
    expect(await follows.isFollowing("u-fan", "u-creator")).toBe(false);
    await follows.follow("u-fan", "u-creator");
    await follows.unfollow("u-fan", "u-creator");
    await follows.unfollow("u-fan", "u-creator");
    expect(await follows.followerCount("u-creator")).toBe(0);
  });

  it("rejects self-follow", async () => {
    const follows = createMemoryFollowStore();
    await expect(follows.follow("u-creator", "u-creator")).rejects.toMatchObject({ status: 400 });
    await expect(follows.unfollow("u-creator", "u-creator")).rejects.toMatchObject({ status: 400 });
    expect(() => validateFollowPair("", "u-creator")).toThrow();
  });

  it("lists who a customer follows", async () => {
    const follows = createMemoryFollowStore();
    await follows.follow("u-fan", "u-creator");
    await follows.follow("u-fan", "u-other");
    expect(await follows.followingList("u-fan")).toEqual(["u-creator", "u-other"]);
    expect(await follows.followingList("u-stranger")).toEqual([]);
  });

  it("reflects follow state on the public profile", async () => {
    const follows = createMemoryFollowStore();
    const deps = { store: emptyStore, source: sourceWith(), follows, viewerUserId: "u-fan" };
    expect((await getPublicCreatorProfile("endurance", deps))?.isFollowing).toBe(false);
    await follows.follow("u-fan", "u-creator");
    const after = await getPublicCreatorProfile("endurance", deps);
    expect(after?.isFollowing).toBe(true);
    expect(after?.followerCount).toBe(1);
  });
});
