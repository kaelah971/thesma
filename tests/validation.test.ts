import { describe, expect, it } from "vitest";
import {
  createPartnerSchema,
  createWorkspaceSchema,
  signinSchema,
  signupSchema,
  updatePartnerSchema,
} from "@/server/domain/validation";

describe("domain validation (request boundaries)", () => {
  it("rejects empty workspace names and overlong categories", () => {
    expect(createWorkspaceSchema.safeParse({ name: "" }).success).toBe(false);
    expect(createWorkspaceSchema.safeParse({ name: "   " }).success).toBe(false);
    expect(
      createWorkspaceSchema.safeParse({ name: "Acme", category: "x".repeat(101) }).success,
    ).toBe(false);
    expect(createWorkspaceSchema.safeParse({ name: "Acme" }).success).toBe(true);
  });

  it("rejects bad signup/signin shapes", () => {
    expect(signupSchema.safeParse({ email: "not-an-email", password: "longenough1" }).success).toBe(false);
    expect(signupSchema.safeParse({ email: "a@b.co", password: "short" }).success).toBe(false);
    expect(signupSchema.safeParse({ email: "a@b.co", password: "longenough1" }).success).toBe(true);
    expect(signinSchema.safeParse({ email: "a@b.co" }).success).toBe(false);
  });

  it("rejects invalid payout wallets but allows null/omitted (S0 nullable)", () => {
    expect(createPartnerSchema.safeParse({ payoutWallet: "0x123" }).success).toBe(false);
    expect(createPartnerSchema.safeParse({ payoutWallet: null }).success).toBe(true);
    expect(createPartnerSchema.safeParse({}).success).toBe(true);
    expect(
      createPartnerSchema.safeParse({
        payoutWallet: "0x1234567890123456789012345678901234567890",
      }).success,
    ).toBe(true);
  });

  it("rejects floating-point micro-USDC and enforces exact integers", () => {
    expect(
      createPartnerSchema.safeParse({ rulesJson: { minBountyMicroUSDC: "2.5" } }).success,
    ).toBe(false);
    expect(
      createPartnerSchema.safeParse({ rulesJson: { minBountyMicroUSDC: "-100" } }).success,
    ).toBe(false);
    expect(
      createPartnerSchema.safeParse({ rulesJson: { minBountyMicroUSDC: "2500000" } }).success,
    ).toBe(true);
  });

  it("requires at least one field on partner update", () => {
    expect(updatePartnerSchema.safeParse({}).success).toBe(false);
    expect(updatePartnerSchema.safeParse({ categories: ["media"] }).success).toBe(true);
  });
});
