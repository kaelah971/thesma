import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { isDbConfigured, getDb } from "@/server/db/client";
import { sessions } from "@/server/db/schema";
import { SESSION_COOKIE_NAME, clearSessionCookie, hashSessionToken } from "@/server/auth/session";
import { toApiError, unconfigured } from "@/server/api/errors";

export async function POST() {
  try {
    if (!isDbConfigured()) return unconfigured();
    const jar = await cookies();
    const token = jar.get(SESSION_COOKIE_NAME)?.value;
    if (token) {
      await getDb().delete(sessions).where(eq(sessions.tokenHash, hashSessionToken(token)));
    }
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json", "Set-Cookie": clearSessionCookie() },
    });
  } catch (err) {
    return toApiError(err);
  }
}
