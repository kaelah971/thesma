import { describe, expect, it } from "vitest";
import { campaignKeyFor, hashRulesJson, policyHashFor, stableStringify } from "@/server/chain/keys";

const BASE = {
  campaignId: "11111111-2222-4333-8444-555555555555",
  policyVersion: 1,
  targetOutcomeCount: 5,
  budgetMicroUsdc: 15_000_000n,
  bountyFloorMicroUsdc: 2_000_000n,
  bountyCeilingMicroUsdc: 4_000_000n,
  minQualifyingPurchaseMicroUsdc: 10_000_000n,
  deadline: new Date("2026-12-31T23:59:59.999Z"),
  marketVisibility: "PUBLIC",
  refundHoldSeconds: 0,
  allowedPartnerRules: {},
  escalationRules: {},
  companyWallet: "0x000000000000000000000000000000000000a11c",
};

describe("canonical campaign bindings", () => {
  it("matches the pinned cross-stack vectors (see contracts/test/KeyVector.t.sol)", () => {
    expect(campaignKeyFor(BASE.campaignId, 1)).toBe(
      "0xf88a7b0f88c7ebd8d446255ca8d28f2fc0eb449d297cd03493c09914100904ff",
    );
    expect(policyHashFor(BASE)).toBe(
      "0x9525fd1fd9b4bb4dc765a39d43fbb9f3513df62431e0aa8e57766311a46569ba",
    );
  });

  it("is deterministic and version-sensitive", () => {
    expect(policyHashFor(BASE)).toBe(policyHashFor({ ...BASE }));
    expect(campaignKeyFor(BASE.campaignId, 1)).toBe(campaignKeyFor(BASE.campaignId, 1));
    expect(campaignKeyFor(BASE.campaignId, 1)).not.toBe(campaignKeyFor(BASE.campaignId, 2));
    expect(policyHashFor(BASE)).not.toBe(policyHashFor({ ...BASE, policyVersion: 2 }));
    expect(policyHashFor(BASE)).not.toBe(policyHashFor({ ...BASE, budgetMicroUsdc: 15_000_001n }));
  });

  it("hashes rule objects independent of key order (never raw JSON.stringify)", () => {
    expect(hashRulesJson({ b: 1, a: [3, 2, { z: 1, y: 2 }] })).toBe(
      hashRulesJson({ a: [3, 2, { y: 2, z: 1 }], b: 1 }),
    );
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("rejects malformed wallets and versions instead of hashing them", () => {
    expect(() => policyHashFor({ ...BASE, companyWallet: "0x123" })).toThrow();
    expect(() => campaignKeyFor(BASE.campaignId, 0)).toThrow();
    expect(() => campaignKeyFor("", 1)).toThrow();
  });
});
