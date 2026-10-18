import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/services/payouts", () => ({ processEligiblePayouts: vi.fn() }));
vi.mock("@/server/api/campaignDeps", () => ({ payoutWorkerDepsOr503: vi.fn() }));

import { payoutWorkerDepsOr503 } from "@/server/api/campaignDeps";
import { processEligiblePayouts } from "@/server/services/payouts";
import { GET, POST } from "@/app/internal/payouts/process/route";

const worker = vi.mocked(processEligiblePayouts);
const wired = vi.mocked(payoutWorkerDepsOr503);

const SAVED = { ...process.env };

function auth(secret: string) {
  return { authorization: `Bearer ${secret}` };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "test-cron-secret-0123456789";
  process.env.PAYOUT_WORKER_SECRET = "test-worker-secret-0123456789";
  process.env.VERIFIER_INTERNAL_SECRET = "test-verifier-secret-0123456789";
  wired.mockReturnValue({ deps: {} as never });
  worker.mockResolvedValue({ processed: 0, reserved: 0, submitted: 0, settled: 0, skipped: [], failed: [] } as never);
});

afterEach(() => {
  process.env = { ...SAVED };
});

describe("payout cron adapter (GET /internal/payouts/process)", () => {
  it("rejects a missing secret", async () => {
    const res = await GET(new Request("http://x/internal/payouts/process", { method: "GET" }));
    expect(res.status).toBe(401);
    expect(worker).not.toHaveBeenCalled();
  });

  it("rejects a wrong secret", async () => {
    const res = await GET(
      new Request("http://x/internal/payouts/process", { method: "GET", headers: auth("wrong-secret-value-xxxx") }),
    );
    expect(res.status).toBe(401);
    expect(worker).not.toHaveBeenCalled();
  });

  it("invokes the existing worker exactly once with the default limit", async () => {
    const summary = {
      processed: 1,
      reserved: 0,
      submitted: 0,
      settled: 0,
      skipped: [{ outcomeId: "o1", reason: "HOLD_ACTIVE" }],
      failed: [],
    };
    worker.mockResolvedValue(summary as never);
    const res = await GET(
      new Request("http://x/internal/payouts/process", {
        method: "GET",
        headers: auth("test-cron-secret-0123456789"),
      }),
    );
    expect(res.status).toBe(200);
    expect(worker).toHaveBeenCalledTimes(1);
    expect(worker).toHaveBeenCalledWith(expect.anything(), { limit: 25 });
    // HOLD_ACTIVE outcome passes straight through the shared worker summary.
    expect(await res.json()).toEqual(summary);
  });

  it("accepts the existing internal worker secret on the cron route", async () => {
    const res = await GET(
      new Request("http://x/internal/payouts/process", {
        method: "GET",
        headers: auth("test-worker-secret-0123456789"),
      }),
    );
    expect(res.status).toBe(200);
    expect(worker).toHaveBeenCalledTimes(1);
  });

  it("keeps the existing POST worker route working through the same service", async () => {
    const res = await POST(
      new Request("http://x/internal/payouts/process", {
        method: "POST",
        headers: { ...auth("test-worker-secret-0123456789"), "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(200);
    expect(worker).toHaveBeenCalledTimes(1);
    expect(worker).toHaveBeenCalledWith(expect.anything(), { limit: 25 });
  });

  it("contains no duplicate payout business logic", () => {
    const src = readFileSync(
      path.resolve(__dirname, "../src/app/internal/payouts/process/route.ts"),
      "utf8",
    );
    // Both entry points delegate to the one shared service call.
    expect(src).toContain("processEligiblePayouts");
    for (const forbidden of [
      "HOLD_ACTIVE",
      "holdUntil",
      "OutcomePaid",
      "insertSpendReservation",
      "updateOutcome",
      "submitPayout",
      "reservation",
    ]) {
      expect(src.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});
