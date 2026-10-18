import type { Metadata } from "next";
import { BuyCheckout } from "@/components/buy/BuyCheckout";
import { LogoMark } from "@/components/brand/Logo";

export const metadata: Metadata = { title: "Secure checkout" };

export default async function BuyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const handle = params.thesma_attribution;
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
          {handle ? (
            <>
              <p style={{ margin: 0, fontSize: 14, opacity: 0.75 }}>
                Pay with USDC on Arc Mainnet. Your payment is verified onchain before
                anything is counted — Thesma never takes custody of your wallet.
              </p>
              <BuyCheckout handle={handle} />
            </>
          ) : (
            <p style={{ margin: 0, fontSize: 14 }}>
              This purchase link is missing its reference. Please return to the campaign page and use its purchase link.
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
