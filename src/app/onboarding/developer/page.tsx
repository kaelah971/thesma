import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { OnboardingShell } from "@/components/start/OnboardingShell";
import { DeveloperForm } from "@/components/start/OnboardingForms";
import { getSessionUser } from "@/server/auth/guard";

export const metadata: Metadata = { title: "Developer onboarding" };

export default async function DeveloperOnboardingPage() {
  const user = await getSessionUser();
  if (!user) redirect("/signin?next=/onboarding/developer");
  return (
    <OnboardingShell
      eyebrow="Build with Thesma · step 1 of 1"
      title="Tell us what you're building"
      copy="Use Thesma's verification, receipts and payout infrastructure in your own product."
    >
      <DeveloperForm initialName={user.name ?? ""} />
    </OnboardingShell>
  );
}
