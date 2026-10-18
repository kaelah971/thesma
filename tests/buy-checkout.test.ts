import { describe, expect, it } from "vitest";
import { shouldShowError, type BuyPhase } from "@/components/buy/BuyCheckout";

const ALL_PHASES: BuyPhase[] = ["loading", "ready", "signing", "submitted", "verified", "failed", "ambiguous"];

describe("buy checkout ready-phase error visibility", () => {
  it("shows connection/preflight errors while still on the ready screen", async () => {
    const mod = await import("@/components/buy/BuyCheckout");
    expect(mod.shouldShowError("ready", "Wrong network (1).")).toBe(true);
  });

  it("shows errors in terminal phases and hides them mid-flow or when empty", () => {
    expect(shouldShowError("failed", "Payment not verified.")).toBe(true);
    expect(shouldShowError("ambiguous", "Status unclear.")).toBe(true);
    for (const phase of ["loading", "signing", "submitted", "verified"] as BuyPhase[]) {
      expect(shouldShowError(phase, "Something broke.")).toBe(false);
    }
    for (const phase of ALL_PHASES) {
      expect(shouldShowError(phase, null)).toBe(false);
      expect(shouldShowError(phase, "")).toBe(false);
    }
  });
});
