import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/health/route";

describe("health/readiness", () => {
  it("reports status without requiring a database", async () => {
    const res = await GET();
    const body = await res.json();
    expect(["ok", "degraded"]).toContain(body.status);
    expect(body.slice).toBe("S0");
    expect(body.checks).toHaveProperty("db");
    expect(typeof body.timestamp).toBe("string");
  });
});
