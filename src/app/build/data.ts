import { cache } from "react";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/server/auth/guard";
import { getPersonaByUserId, personaFromEnum } from "@/server/services/personas";
import { listUserWorkspaces } from "@/server/services/workspaces";

export const getDeveloperContext = cache(async () => {
  const user = await getSessionUser();
  if (!user) redirect("/signin?next=/build");

  const persona = await getPersonaByUserId(user.userId);
  if (!persona || !persona.onboardingCompletedAt) redirect("/onboarding/developer");
  if (personaFromEnum(persona.persona) !== "developer") redirect("/start?change=1");

  const memberships = await listUserWorkspaces(user.userId).catch(() => []);
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
