import { LogoMark } from "@/components/brand/Logo";
import { Card } from "@/components/app/ui";

/** Instant feedback while the server assembles market proof. */
export default function MarketLoading() {
  return (
    <main style={{ minHeight: "100dvh", padding: "32px 16px 64px" }} aria-busy="true" aria-label="Loading market proof">
      <div style={{ width: "100%", maxWidth: 960, margin: "0 auto", display: "grid", gap: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <LogoMark size={32} />
          <p style={{ margin: 0, fontWeight: 800, letterSpacing: 2, fontSize: 13 }}>THESMA · PUBLIC MARKET</p>
        </div>
        <Card title="Loading market proof…">
          <p style={{ margin: 0, fontSize: 14, opacity: 0.7 }}>
            Fetching campaign, funding, purchase and payout evidence from Arc Mainnet…
          </p>
        </Card>
      </div>
    </main>
  );
}
