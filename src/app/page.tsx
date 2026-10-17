import { Hero } from "@/components/landing/Hero";
import {
  ClosingCta,
  DevelopersSection,
  FaqSection,
  HowItWorks,
  OperatorShowcase,
  SiteFooter,
  TrustSection,
  ValueSection,
} from "@/components/landing/Sections";

export default function Home() {
  return (
    <>
      <Hero />
      <main>
        <ValueSection />
        <HowItWorks />
        <OperatorShowcase />
        <TrustSection />
        <DevelopersSection />
        <FaqSection />
        <ClosingCta />
      </main>
      <SiteFooter />
    </>
  );
}
