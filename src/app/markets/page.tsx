import type { Metadata } from "next";
import Link from "next/link";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { listCompletedMarkets, listPublicMarkets } from "@/server/services/markets";
import { LogoMark } from "@/components/brand/Logo";
import { Card, EmptyState, PageHeader, Pill } from "@/components/app/ui";
import { formatUsdc } from "@/lib/format";

export const metadata: Metadata = { title: "Live markets" };

async function load() {
  const wired = marketDepsOr503();
  if ("response" in wired) return { live: [], completed: [], degraded: true };
  const [live, completed] = await Promise.all([listPublicMarkets(wired.deps), listCompletedMarkets(wired.deps)]);
  return { live: live.markets, completed: completed.markets, degraded: false };
}

export default async function MarketsPage() {
  const { live, completed, degraded } = await load();
  return (
    <main style={{ minHeight: "100dvh", padding: "32px 16px 64px" }}>
      <div style={{ width: "100%", maxWidth: 960, margin: "0 auto", display: "grid", gap: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Link href="/" aria-label="Thesma home">
            <LogoMark size={32} />
          </Link>
          <p style={{ margin: 0, fontWeight: 800, letterSpacing: 2, fontSize: 13 }}>THESMA · PUBLIC MARKETS</p>
        </div>
        <PageHeader
          eyebrow="No login required"
          title="Market discovery"
          description="Live outcome markets you can join, and the completed history with proof of what actually happened."
        />
        {degraded && (
          <Card tone="blue">
            <p style={{ margin: 0, fontSize: 14 }}>Market data is temporarily unavailable. Check back shortly.</p>
          </Card>
        )}
        <section aria-label="Live markets">
          <h2 style={{ fontSize: 18, margin: "0 0 12px" }}>Live markets</h2>
          {live.length === 0 ? (
            <EmptyState title="No live markets right now" body="Completed markets below keep their full proof." />
          ) : (
            <div style={{ display: "grid", gap: 12 }}>
              {live.map((m) => (
                <Card
                  key={m.campaignId}
                  title={
                    <>
                      {m.workspaceName} <Pill tone="mint">LIVE</Pill> <Pill>OPEN</Pill>
                    </>
                  }
                  action={
                    <Link href={`/markets/${m.campaignId}`} className="btn btn-primary btn-sm">
                      View market
                    </Link>
                  }
                >
                  <p style={{ margin: 0, fontSize: 14 }}>
                    Public bounty <strong>{formatUsdc(m.publicBountyMicroUsdc)} USDC</strong> per verified outcome
                    {m.targetOutcomeCount != null && (
                      <> · goal {m.targetOutcomeCount} outcome{m.targetOutcomeCount === 1 ? "" : "s"}</>
                    )}
                  </p>
                  <p style={{ margin: "8px 0 0", fontSize: 13, opacity: 0.7 }}>
                    {m.category ? `Category: ${m.category} · ` : ""}Deadline: {m.deadline}
                  </p>
                </Card>
              ))}
            </div>
          )}
        </section>
        <section aria-label="Completed markets">
          <h2 style={{ fontSize: 18, margin: "0 0 12px" }}>Completed markets</h2>
          {completed.length === 0 ? (
            <EmptyState title="No completed markets yet" body="Finished, closed or expired public markets stay visible here with proof." />
          ) : (
            <div style={{ display: "grid", gap: 12 }}>
              {completed.map((m) => (
                <Card
                  key={m.campaignId}
                  title={
                    <>
                      {m.workspaceName} <Pill>{m.finalState}</Pill> <Pill>{m.marketStatus}</Pill>
                    </>
                  }
                  action={
                    <Link href={`/markets/${m.campaignId}`} className="btn btn-sm">
                      View proof
                    </Link>
                  }
                >
                  <p style={{ margin: 0, fontSize: 14 }}>
                    Goal {m.goal ?? "—"} · verified {m.verifiedOutcomes} · spend{" "}
                    {formatUsdc(m.settledSpendMicroUsdc)} USDC
                    {m.realizedCacMicroUsdc != null && <> · realized CAC {formatUsdc(m.realizedCacMicroUsdc)} USDC</>}
                  </p>
                </Card>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
