import type { Metadata } from "next";
import Link from "next/link";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { listCompletedMarkets, listPublicMarkets } from "@/server/services/markets";
import { LogoMark } from "@/components/brand/Logo";
import { Card, EmptyState, PageHeader, Pill, ProgressBar } from "@/components/app/ui";
import { PublicFooter } from "@/components/trust/PublicFooter";
import { LifecycleStrip } from "@/components/proof/LifecycleStrip";
import { deriveLifecycle } from "@/components/proof/lifecycle";
import { shouldPromoteCompleted } from "@/lib/proof";
import { formatCalendarDate, formatUsdc } from "@/lib/format";

export const metadata: Metadata = { title: "Live markets" };

async function load() {
  const wired = marketDepsOr503();
  if ("response" in wired) return { live: [], completed: [], degraded: true };
  try {
    const [live, completed] = await Promise.all([listPublicMarkets(wired.deps), listCompletedMarkets(wired.deps)]);
    return { live: live.markets, completed: completed.markets, degraded: false };
  } catch {
    // Runtime infra failure (e.g. DB configured but unreachable) is not
    // empty data: show the unavailable state, never "No live markets".
    // The error itself is never rendered (no hostnames, SQL, or secrets).
    return { live: [], completed: [], degraded: true };
  }
}

export default async function MarketsPage() {
  const { live, completed, degraded } = await load();
  // Zero-live state: completed proof is the valuable content, so it renders
  // first with only a compact live notice. The fact stays visible.
  const promoteCompleted = shouldPromoteCompleted(live.length, completed.length);
  return (
    <main style={{ minHeight: "100dvh", padding: "32px 16px 64px" }}>
      <div style={{ width: "100%", maxWidth: 960, margin: "0 auto", display: "grid", gap: 28 }}>
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
        {promoteCompleted && <CompletedMarkets completed={completed} />}
        {!promoteCompleted && (
        <section aria-label="Live markets">
          <h2 style={{ fontSize: 18, margin: "0 0 12px" }}>Live markets</h2>
          {live.length === 0 ? (
            <EmptyState title="No live markets right now" body="Completed markets below keep their full proof." />
          ) : (
            <div style={{ display: "grid", gap: 12 }}>
              {live.map((m) => (
                <article
                  key={m.campaignId}
                  style={{
                    border: "1px solid var(--line, #e5e5e5)",
                    borderRadius: 18,
                    background: "var(--surface, #fff)",
                    padding: "20px 20px 16px",
                    display: "grid",
                    gap: 12,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                    <h3 style={{ margin: 0, fontSize: 17 }}>{m.workspaceName}</h3>
                    <span style={{ display: "inline-flex", gap: 6 }}>
                      <Pill tone="mint">LIVE</Pill>
                      <Pill>{m.marketStatus}</Pill>
                    </span>
                  </div>
                  <p className="tnum" style={{ margin: 0, fontSize: 34, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.1 }}>
                    {formatUsdc(m.publicBountyMicroUsdc)}{" "}
                    <span style={{ fontSize: 15, fontWeight: 500, opacity: 0.65 }}>USDC</span>
                  </p>
                  <p style={{ margin: 0, fontSize: 13.5, opacity: 0.75 }}>per verified outcome</p>
                  {m.targetOutcomeCount != null && (
                    <ProgressBar
                      value={m.verifiedOutcomes}
                      max={m.targetOutcomeCount}
                      label={`${m.verifiedOutcomes} of ${m.targetOutcomeCount} verified`}
                    />
                  )}
                  <LifecycleStrip
                    variant="inline"
                    label={`${m.workspaceName} lifecycle`}
                    steps={deriveLifecycle({
                      fundingStatus: m.fundingStatus,
                      verifiedOutcomes: m.verifiedOutcomes,
                      settledPayouts: m.settledPayouts,
                      target: m.targetOutcomeCount,
                    })}
                  />
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                      flexWrap: "wrap",
                      borderTop: "1px solid var(--line, #e5e5e5)",
                      paddingTop: 12,
                    }}
                  >
                    <p style={{ margin: 0, fontSize: 13, opacity: 0.7 }}>
                      {m.category ? `${m.category} · ` : ""}Deadline {formatCalendarDate(m.deadline)}
                    </p>
                    <Link href={`/markets/${m.campaignId}`} className="btn btn-primary btn-sm">
                      View market
                    </Link>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
        )}
        {promoteCompleted && (
        <section aria-label="Live markets">
          <h2 style={{ fontSize: 18, margin: "0 0 12px" }}>Live markets</h2>
          <p style={{ margin: 0, fontSize: 13, opacity: 0.7 }}>No live markets right now.</p>
        </section>
        )}
        {!promoteCompleted && <CompletedMarkets completed={completed} />}
        <PublicFooter />
      </div>
    </main>
  );
}

type CompletedItem = {
  campaignId: string;
  workspaceName: string;
  fundingStatus: string | null;
  goal: number | null;
  finalState: string;
  marketStatus: string;
  completionReason: string;
  verifiedOutcomes: number;
  settledPayouts: number;
  settledSpendMicroUsdc: string;
  realizedCacMicroUsdc: string | null;
};

/** Completed proof. Rendered FIRST when no live market exists (see above). */
function CompletedMarkets({ completed }: { completed: CompletedItem[] }) {
  return (
    <section aria-label="Completed markets" id="completed">
      <h2 style={{ fontSize: 18, margin: "0 0 12px" }}>Completed markets</h2>
      {completed.length === 0 ? (
        <EmptyState title="No completed markets yet" body="Finished, closed or expired public markets stay visible here with proof." />
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {completed.map((m) => (
            <CompletedCard key={m.campaignId} m={m} />
          ))}
        </div>
      )}
    </section>
  );
}

function CompletedCard({ m }: { m: CompletedItem }) {
  const settled = m.completionReason === "TARGET_SETTLED";
  return (
    <article
      style={{
        border: settled ? "1px solid var(--ink, #131417)" : "1px solid var(--line, #e5e5e5)",
        borderRadius: 18,
        background: "var(--surface, #fff)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          background: settled ? "var(--ink, #131417)" : "var(--paper-2, #efede7)",
          color: settled ? "#fff" : "var(--ink, #131417)",
          padding: "12px 20px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <h3 style={{ margin: 0, fontSize: 16 }}>{m.workspaceName}</h3>
        {settled ? (
          <span className="pill" data-tone="mint">
            Target reached · Settled
          </span>
        ) : (
          <span style={{ display: "inline-flex", gap: 6 }}>
            <Pill>{m.finalState}</Pill>
            <Pill>{m.marketStatus}</Pill>
          </span>
        )}
      </div>
      <div style={{ padding: "16px 20px", display: "grid", gap: 12 }}>
        <p className="tnum" style={{ margin: 0, fontSize: 15 }}>
          Goal {m.goal ?? "—"} · verified {m.verifiedOutcomes} · settled{" "}
          {formatUsdc(m.settledSpendMicroUsdc)} USDC
          {m.realizedCacMicroUsdc != null && (
            <> · realized CAC {formatUsdc(m.realizedCacMicroUsdc)} USDC</>
          )}
        </p>
        <LifecycleStrip
          variant="inline"
          label={`${m.workspaceName} lifecycle`}
          steps={deriveLifecycle({
            fundingStatus: m.fundingStatus,
            verifiedOutcomes: m.verifiedOutcomes,
            settledPayouts: m.settledPayouts,
            target: m.goal,
          })}
        />
        <div>
          <Link href={`/markets/${m.campaignId}`} className="btn btn-sm">
            View proof
          </Link>
        </div>
      </div>
    </article>
  );
}
