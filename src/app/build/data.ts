import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/server/auth/guard";
import {
  PERSONA_COOKIE,
  PERSONA_INTENT_COOKIE,
  parsePersona,
  personaFromEnum,
  resolveProductPersona,
} from "@/server/services/personas";
import { listUserWorkspaces } from "@/server/services/workspaces";

export const getDeveloperContext = cache(async () => {
  const user = await getSessionUser();
  if (!user) redirect("/signin?next=/build");

  const memberships = await listUserWorkspaces(user.userId).catch(() => []);
  const jar = await cookies();
  const persona = await resolveProductPersona({
    userId: user.userId,
    selectedPersona: parsePersona(jar.get(PERSONA_COOKIE)?.value),
    explicitPersona: parsePersona(jar.get(PERSONA_INTENT_COOKIE)?.value),
    legacyDeveloperSignal: memberships.length > 0,
  });
  if (!persona || !persona.onboardingCompletedAt) redirect("/onboarding/developer");
  if (personaFromEnum(persona.persona) !== "developer") redirect("/start?change=1");

  const workspace = memberships.find((item) => item.role === "ORGANIZATION_OWNER")?.workspace ?? null;
  return {
    user,
    persona,
    workspace,
    projectName: workspace?.name ?? null,
    productDescription: persona.project ?? null,
  };
});

export type DeveloperContext = Awaited<ReturnType<typeof getDeveloperContext>>;
