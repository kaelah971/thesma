import { eq } from "drizzle-orm";
import { isDbConfigured, getDb } from "@/server/db/client";
import { sessions, users } from "@/server/db/schema";
import { hashPassword } from "@/server/auth/password";
import { newId, newSessionToken, hashSessionToken, sessionCookie, sessionExpiry } from "@/server/auth/session";
import { signupSchema } from "@/server/domain/validation";
import { badRequest, conflict, toApiError, unconfigured } from "@/server/api/errors";

export async function POST(req: Request) {
  try {
    if (!isDbConfigured()) return unconfigured();
    const body = await req.json().catch(() => null);
    const parsed = signupSchema.safeParse(body);
    if (!parsed.success) return badRequest("Invalid signup request", parsed.error.flatten());
    const db = getDb();
    const email = parsed.data.email.toLowerCase().trim();
    const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing) return conflict("Email is already registered");

    const userId = newId();
    await db.insert(users).values({
      id: userId,
      email,
      passwordHash: await hashPassword(parsed.data.password),
      name: parsed.data.name ?? null,
    });

    const token = newSessionToken();
    await db.insert(sessions).values({
      id: newId(),
      userId,
      tokenHash: hashSessionToken(token),
      expiresAt: sessionExpiry(),
    });

    const secure = new URL(req.url).protocol === "https:";
    return new Response(JSON.stringify({ user: { id: userId, email } }), {
      status: 201,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": sessionCookie(token, secure),
      },
    });
  } catch (err) {
    return toApiError(err);
  }
}
