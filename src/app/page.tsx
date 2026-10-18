import { Hero } from "@/components/landing/Hero";
import { RevealObserver } from "@/components/landing/RevealObserver";
import {
  ClosingCta,
  FaqSection,
  HowItWorks,
  OperatorShowcase,
  ReceiptsSection,
  SiteFooter,
  TrustSection,
  ValueSection,
} from "@/components/landing/Sections";
import styles from "@/components/landing/landing.module.css";

export default function Home() {
  return (
    <div className={styles.page}>
      <Hero />
      <main>
        <ValueSection />
        <HowItWorks />
        <OperatorShowcase />
        <TrustSection />
        <ReceiptsSection />
        <FaqSection />
        <ClosingCta />
      </main>
      <SiteFooter />
      <RevealObserver />
    </div>
  );
}
