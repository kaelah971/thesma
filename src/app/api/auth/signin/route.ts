import { eq } from "drizzle-orm";
import { isDbConfigured, getDb } from "@/server/db/client";
import { sessions, users } from "@/server/db/schema";
import { verifyPassword } from "@/server/auth/password";
import { newId, newSessionToken, hashSessionToken, sessionCookie, sessionExpiry } from "@/server/auth/session";
import { signinSchema } from "@/server/domain/validation";
import { badRequest, toApiError, unauthorized, unconfigured } from "@/server/api/errors";

export async function POST(req: Request) {
  try {
    if (!isDbConfigured()) return unconfigured();
    const body = await req.json().catch(() => null);
    const parsed = signinSchema.safeParse(body);
    if (!parsed.success) return badRequest("Invalid signin request", parsed.error.flatten());
    const db = getDb();
    const email = parsed.data.email.toLowerCase().trim();
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
      return unauthorized("Invalid email or password");
    }
    const token = newSessionToken();
    await db.insert(sessions).values({
      id: newId(),
      userId: user.id,
      tokenHash: hashSessionToken(token),
      expiresAt: sessionExpiry(),
    });
    const secure = new URL(req.url).protocol === "https:";
    return new Response(
      JSON.stringify({ user: { id: user.id, email: user.email, name: user.name } }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": sessionCookie(token, secure),
        },
      },
    );
  } catch (err) {
    return toApiError(err);
  }
}
