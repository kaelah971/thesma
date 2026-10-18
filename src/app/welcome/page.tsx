import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { isDbConfigured, getDb } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { getSessionUser } from "@/server/auth/guard";
import { getPartnerByUserId } from "@/server/services/partners";
import { listUserWorkspaces } from "@/server/services/workspaces";
import {
  PERSONA_COOKIE,
  getPersonaByUserId,
  onboardingPath,
  parsePersona,
  personaFromEnum,
  personaHome,
  upsertPersona,
} from "@/server/services/personas";

/**
 * Post-auth entry resolver. Reads the pre-auth persona cookie + any stored
 * persona row, persists the choice, then sends the user to the correct
 * onboarding or their finished role home. Pure routing — no authz, no writes
 * to financial tables.
 */
export default async function WelcomePage() {
  if (!isDbConfigured()) redirect("/start");
  const user = await getSessionUser();
  if (!user) redirect("/signin?next=/welcome");

  const jar = await cookies();
  const cookiePersona = parsePersona(jar.get(PERSONA_COOKIE)?.value);

  let row = await getPersonaByUserId(user.userId);
  if (!row && cookiePersona) {
    try {
      row = await upsertPersona(user.userId, { persona: cookiePersona });
    } catch {
      row = null;
    }
  }
  const persona = row ? personaFromEnum(row.persona) : cookiePersona;
  if (!persona) redirect("/start");

  const completed = Boolean(row?.onboardingCompletedAt);
  const memberships = await listUserWorkspaces(user.userId).catch(() => []);
  const partner = await getPartnerByUserId(user.userId).catch(() => null);
  const [dbUser] = await getDb().select().from(users).where(eq(users.id, user.userId)).limit(1).catch(() => []);

  switch (persona) {
    case "organization": {
      if (memberships.length > 0) {
        // Existing organizations keep working: ensure the row reflects reality.
        if (!completed) {
          try {
            await upsertPersona(user.userId, { persona, complete: true });
          } catch {
            /* best-effort */
          }
        }
        redirect(personaHome(persona));
      }
      redirect(onboardingPath(persona));
    }
    case "creator": {
      if (completed && partner) redirect(personaHome(persona));
      redirect(onboardingPath(persona));
    }
    case "customer": {
      if (completed) redirect(personaHome(persona));
      if (!dbUser?.name) redirect(onboardingPath(persona));
      // Name already known (e.g. from signup): finish silently.
      try {
        await upsertPersona(user.userId, { persona, complete: true });
      } catch {
        /* best-effort */
      }
      redirect(personaHome(persona));
    }
    case "developer": {
      if (completed) redirect(personaHome(persona));
      redirect(onboardingPath(persona));
    }
  }
}
