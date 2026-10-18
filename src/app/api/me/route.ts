import { eq } from "drizzle-orm";
import { getDb, isDbConfigured } from "@/server/db/client";
import { partners } from "@/server/db/schema";
import { getSessionUser } from "@/server/auth/guard";
import { getPersonaByUserId, personaFromEnum } from "@/server/services/personas";
import { listUserWorkspaces } from "@/server/services/workspaces";
import { unauthorized, unconfigured } from "@/server/api/errors";

export async function GET() {
  if (!isDbConfigured()) return unconfigured();
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const db = getDb();
  const memberships = await listUserWorkspaces(user.userId);
  const [partner] = await db.select().from(partners).where(eq(partners.userId, user.userId)).limit(1);
  const persona = await getPersonaByUserId(user.userId);
  return Response.json({
    user,
    workspaces: memberships.map((m) => ({ ...m.workspace, role: m.role })),
    partner: partner ?? null,
    persona: persona
      ? { persona: personaFromEnum(persona.persona), onboardingCompletedAt: persona.onboardingCompletedAt?.toISOString() ?? null }
      : null,
  });
}
