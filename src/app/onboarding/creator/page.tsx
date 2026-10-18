import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { OnboardingShell } from "@/components/start/OnboardingShell";
import { CreatorForm } from "@/components/start/OnboardingForms";
import { getSessionUser } from "@/server/auth/guard";

export const metadata: Metadata = { title: "Creator onboarding" };

export default async function CreatorOnboardingPage() {
  const user = await getSessionUser();
  if (!user) redirect("/signin?next=/onboarding/creator");
  return (
    <OnboardingShell
      eyebrow="Creator / KOL · step 1 of 1"
      title="Set up your creator profile"
      copy="Join live campaigns, share referral links, and earn when verified outcomes happen."
    >
      <CreatorForm initialName={user.name ?? ""} />
    </OnboardingShell>
  );
}
