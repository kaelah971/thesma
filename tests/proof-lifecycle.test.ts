import { describe, expect, it } from "vitest";
import { deriveLifecycle } from "@/components/proof/lifecycle";

describe("lifecycle derivation (truth rules)", () => {
  it("marks SETTLED done only with reconciled payouts, never from time", () => {
    const steps = deriveLifecycle({ fundingStatus: "CONFIRMED", verifiedOutcomes: 1, settledPayouts: 0, target: 1 });
    const settled = steps.find((s) => s.key === "SETTLED")!;
    expect(settled.state).toBe("pending");
    // Held waits while verified outcomes have no payouts yet.
    expect(steps.find((s) => s.key === "HELD")!.state).toBe("active-wait");
  });

  it("marks SETTLED terminal once payouts settle, and hold done", () => {
    const steps = deriveLifecycle({
      fundingStatus: "CONFIRMED",
      verifiedOutcomes: 1,
      settledPayouts: 1,
      target: 1,
      settledTotal: "1.00 USDC",
    });
    expect(steps.find((s) => s.key === "SETTLED")).toMatchObject({ state: "terminal", sublabel: "1.00 USDC" });
    expect(steps.find((s) => s.key === "HELD")!.state).toBe("done");
  });

  it("stays honest with no target and no funding", () => {
    const steps = deriveLifecycle({ fundingStatus: null, verifiedOutcomes: 0, settledPayouts: 0, target: null });
    expect(steps.find((s) => s.key === "FUNDED")!.state).toBe("pending");
    expect(steps.find((s) => s.key === "SETTLED")!.state).toBe("pending");
    expect(steps).toHaveLength(5);
  });

  it("never reports active settlement", () => {
    const steps = deriveLifecycle({ fundingStatus: "SUBMITTED", verifiedOutcomes: 2, settledPayouts: 0, target: 2 });
    expect(steps.find((s) => s.key === "FUNDED")!.state).toBe("active-info");
    const settled = steps.find((s) => s.key === "SETTLED")!;
    expect(["pending", "terminal"]).toContain(settled.state);
  });
});
