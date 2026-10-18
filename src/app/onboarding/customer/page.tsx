import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { OnboardingShell } from "@/components/start/OnboardingShell";
import { CustomerForm } from "@/components/start/OnboardingForms";
import { getSessionUser } from "@/server/auth/guard";

export const metadata: Metadata = { title: "Customer onboarding" };

export default async function CustomerOnboardingPage() {
  const user = await getSessionUser();
  if (!user) redirect("/signin?next=/onboarding/customer");
  return (
    <OnboardingShell
      eyebrow="Customer · step 1 of 1"
      title="Set up your customer profile"
      copy="Thesma keeps track of outcomes you've completed through creators you follow."
    >
      <CustomerForm initialName={user.name ?? ""} />
    </OnboardingShell>
  );
}
