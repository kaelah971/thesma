import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { OnboardingShell } from "@/components/start/OnboardingShell";
import { OrganizationForm } from "@/components/start/OnboardingForms";
import { getSessionUser } from "@/server/auth/guard";
import { listUserWorkspaces } from "@/server/services/workspaces";

export const metadata: Metadata = { title: "Organization onboarding" };

export default async function OrganizationOnboardingPage() {
  const user = await getSessionUser();
  if (!user) redirect("/signin?next=/onboarding/organization");
  // Existing organizations keep working — a workspace means onboarding is done.
  const memberships = await listUserWorkspaces(user.userId).catch(() => []);
  if (memberships.length > 0) redirect("/app");
  return (
    <OnboardingShell
      eyebrow="Organization · step 1 of 2"
      title="Create your workspace"
      copy="Then describe the result you want — Thesma helps turn it into campaign rules, verification, payouts and reporting."
    >
      <OrganizationForm />
    </OnboardingShell>
  );
}
