import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/services/scout", () => ({ runBackgroundScout: vi.fn() }));
vi.mock("@/server/api/campaignDeps", () => ({ marketDepsOr503: vi.fn() }));

import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { runBackgroundScout } from "@/server/services/scout";
import { GET, POST } from "@/app/internal/agents/scout/run/route";

const worker = vi.mocked(runBackgroundScout);
const wired = vi.mocked(marketDepsOr503);

const SAVED = { ...process.env };

function auth(secret: string) {
  return { authorization: `Bearer ${secret}` };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "test-cron-secret-0123456789";
  process.env.SCOUT_WORKER_SECRET = "test-worker-secret-0123456789";
  delete process.env.SUPPLY_AGENT_WORKER_SECRET;
  delete process.env.VERIFIER_INTERNAL_SECRET;
  wired.mockReturnValue({ deps: {} as never });
  worker.mockResolvedValue({ autoJoins: 0 } as never);
});

afterEach(() => {
  process.env = { ...SAVED };
});

describe("scout cron adapter (GET /internal/agents/scout/run)", () => {
  it("rejects a missing secret", async () => {
    const res = await GET(new Request("http://x/internal/agents/scout/run", { method: "GET" }));
    expect(res.status).toBe(401);
    expect(worker).not.toHaveBeenCalled();
  });

  it("rejects a wrong secret", async () => {
    const res = await GET(
      new Request("http://x/internal/agents/scout/run", { method: "GET", headers: auth("wrong-secret-value-xxxx") }),
    );
    expect(res.status).toBe(401);
    expect(worker).not.toHaveBeenCalled();
  });

  it("accepts CRON_SECRET and runs the background worker once", async () => {
    const res = await GET(
      new Request("http://x/internal/agents/scout/run", {
        method: "GET",
        headers: auth("test-cron-secret-0123456789"),
      }),
    );
    expect(res.status).toBe(200);
    expect(worker).toHaveBeenCalledTimes(1);
  });

  it("manual POST requires the worker secret, not the cron secret alone", async () => {
    const denied = await POST(
      new Request("http://x/internal/agents/scout/run", { method: "POST", headers: auth("test-cron-secret-0123456789") }),
    );
    expect(denied.status).toBe(401);
    expect(worker).not.toHaveBeenCalled();
    const ok = await POST(
      new Request("http://x/internal/agents/scout/run", { method: "POST", headers: auth("test-worker-secret-0123456789") }),
    );
    expect(ok.status).toBe(200);
    expect(worker).toHaveBeenCalledTimes(1);
  });
});
