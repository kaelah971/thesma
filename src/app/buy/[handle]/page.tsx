import type { Metadata } from "next";
import { BuyCheckout } from "@/components/buy/BuyCheckout";
import { LogoMark } from "@/components/brand/Logo";

export const metadata: Metadata = { title: "Secure checkout" };

function Shell({ handle }: { handle: string }) {
  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        padding: "32px 16px",
      }}
    >
      <div style={{ width: "100%", maxWidth: 480, display: "grid", gap: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <LogoMark size={32} />
          <div>
            <p style={{ margin: 0, fontWeight: 800, letterSpacing: 2, fontSize: 13 }}>THESMA</p>
            <p style={{ margin: 0, fontSize: 13, opacity: 0.7 }}>Secure checkout</p>
          </div>
        </div>
        <section
          aria-label="Purchase"
          style={{
            border: "1px solid var(--line, #e5e5e5)",
            borderRadius: 16,
            padding: 20,
            display: "grid",
            gap: 12,
            background: "var(--surface, #fff)",
          }}
        >
          <h1 style={{ margin: 0, fontSize: 20 }}>Complete your purchase</h1>
          <p style={{ margin: 0, fontSize: 14, opacity: 0.75 }}>
            Pay with USDC on Arc Mainnet. Your payment is verified onchain before
            anything is counted — Thesma never takes custody of your wallet.
          </p>
          <BuyCheckout handle={handle} />
        </section>
        <p style={{ margin: 0, fontSize: 12, opacity: 0.6, textAlign: "center" }}>
          One purchase per wallet for this campaign. Do not close this page until verification finishes.
        </p>
      </div>
    </main>
  );
}

export default async function BuyHandlePage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  return <Shell handle={handle} />;
}
