import { isDbConfigured, getPool } from "@/server/db/client";

export async function GET() {
  let db: "unconfigured" | "ok" | "error" = "unconfigured";
  if (isDbConfigured()) {
    try {
      const pool = getPool();
      await pool.query("SELECT 1");
      db = "ok";
    } catch {
      db = "error";
    }
  }
  const ok = db !== "error";
  return Response.json(
    {
      status: ok ? "ok" : "degraded",
      version: "0.1.0",
      slice: "S0",
      checks: { db },
      timestamp: new Date().toISOString(),
    },
    { status: ok ? 200 : 503 },
  );
}
