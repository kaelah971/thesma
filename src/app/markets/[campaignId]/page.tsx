import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { getPublicMarketDetail } from "@/server/services/markets";
import { LogoMark } from "@/components/brand/Logo";
import { Card, Facts, PageHeader, Pill, ProgressBar } from "@/components/app/ui";
import { formatDateTime, formatUsdc } from "@/lib/format";

export const metadata: Metadata = { title: "Market" };

export default async function MarketDetailPage({ params }: { params: Promise<{ campaignId: string }> }) {
  const { campaignId } = await params;
  const wired = marketDepsOr503();
  if ("response" in wired) notFound();
  let detail;
  try {
    detail = await getPublicMarketDetail(wired.deps, {
      campaignId,
      explorerBaseUrl: process.env.ARC_EXPLORER_BASE_URL ?? null,
    });
  } catch {
    notFound();
  }
  return (
    <main style={{ minHeight: "100dvh", padding: "32px 16px 64px" }}>
      <div style={{ width: "100%", maxWidth: 960, margin: "0 auto", display: "grid", gap: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Link href="/markets" aria-label="Back to markets">
            <LogoMark size={32} />
          </Link>
          <p style={{ margin: 0, fontWeight: 800, letterSpacing: 2, fontSize: 13 }}>THESMA · PUBLIC MARKET</p>
        </div>
        <PageHeader
          back={{ href: "/markets", label: "All markets" }}
          eyebrow={detail.workspaceName}
          title={
            <>
              {detail.live ? "Live market" : "Completed market"}{" "}
              <Pill tone={detail.live ? "mint" : "neutral"}>{detail.state}</Pill> <Pill>{detail.marketStatus}</Pill>
            </>
          }
          description={detail.objective}
        />
        <Card title="Market terms">
          <Facts
            items={[
              { label: "Public bounty", value: `${formatUsdc(detail.publicBountyMicroUsdc)} USDC` },
              { label: "Approved budget", value: detail.approvedBudgetMicroUsdc ? `${formatUsdc(detail.approvedBudgetMicroUsdc)} USDC` : "—" },
              { label: "Floor / ceiling", value: `${detail.bountyFloorMicroUsdc ? formatUsdc(detail.bountyFloorMicroUsdc) : "—"} / ${detail.bountyCeilingMicroUsdc ? formatUsdc(detail.bountyCeilingMicroUsdc) : "—"} USDC` },
              { label: "Qualifying purchase", value: detail.qualificationRule ? `${formatUsdc(detail.qualificationRule)} USDC` : "—" },
              { label: "Deadline", value: detail.deadline ? formatDateTime(detail.deadline) : "—" },
              { label: "Funding", value: detail.funding ? `${detail.funding.status} · ${formatUsdc(detail.funding.expectedMicroUsdc)} USDC` : "—" },
            ]}
          />
        </Card>
        <Card title="Progress">
          <ProgressBar
            value={detail.progress.verified}
            max={detail.progress.target ?? Math.max(detail.progress.verified, 1)}
            label={`${detail.progress.verified} of ${detail.progress.target ?? "?"} verified`}
          />
          <p style={{ margin: "8px 0 0", fontSize: 13, opacity: 0.7 }}>
            {detail.participatingPartners} participating partner{detail.participatingPartners === 1 ? "" : "s"}
          </p>
        </Card>
        <Card title="Latest agent decision">
          {detail.latestAgentDecision ? (
            <Facts
              items={[
                { label: "Decision", value: detail.latestAgentDecision.decision },
                { label: "Pace", value: detail.latestAgentDecision.paceState },
                { label: "Reasons", value: detail.latestAgentDecision.reasonCodes.join(", ") || "—" },
                { label: "At", value: formatDateTime(detail.latestAgentDecision.createdAt) },
              ]}
            />
          ) : (
            <p style={{ margin: 0, fontSize: 14, opacity: 0.7 }}>No agent decisions recorded yet.</p>
          )}
        </Card>
        {!detail.live && detail.kind === "completed" && (
          <>
            <Card title="Final outcome">
              <Facts
                items={[
                  { label: "Goal reached", value: detail.finalOutcome.reachedTarget ? "Yes" : "Not yet" },
                  { label: "Verified outcomes", value: String(detail.finalOutcome.verifiedOutcomes) },
                  { label: "Campaign spend", value: `${formatUsdc(detail.settledSpendMicroUsdc)} USDC` },
                  { label: "Verified revenue", value: detail.verifiedRevenueMicroUsdc ? `${formatUsdc(detail.verifiedRevenueMicroUsdc)} USDC` : "—" },
                  { label: "Realized CAC", value: detail.realizedCacMicroUsdc ? `${formatUsdc(detail.realizedCacMicroUsdc)} USDC` : "—" },
                  { label: "Remaining budget", value: detail.remainingMicroUsdc ? `${formatUsdc(detail.remainingMicroUsdc)} USDC` : "—" },
                ]}
              />
            </Card>
            <Card title={`Payouts (${detail.payouts.length})`}>
              {detail.payouts.length === 0 ? (
                <p style={{ margin: 0, fontSize: 14, opacity: 0.7 }}>No payouts recorded.</p>
              ) : (
                <div style={{ display: "grid", gap: 8 }}>
                  {detail.payouts.map((p) => (
                    <p key={p.id} style={{ margin: 0, fontSize: 14 }}>
                      {formatUsdc(p.amountMicroUsdc)} USDC → {p.recipient.slice(0, 10)}… · {p.state}
                      {p.txHash && (
                        <>
                          {" · "}
                          {p.explorerUrl ? (
                            <a href={p.explorerUrl} target="_blank" rel="noreferrer">
                              {p.txHash.slice(0, 10)}…↗
                            </a>
                          ) : (
                            <code style={{ fontSize: 12 }}>{p.txHash.slice(0, 18)}…</code>
                          )}
                        </>
                      )}
                    </p>
                  ))}
                </div>
              )}
            </Card>
            <Card title="Proof">
              <p style={{ margin: 0, fontSize: 14 }}>
                Outcome proof hashes: {detail.outcomeProofs.length === 0 ? "—" : detail.outcomeProofs.map((h) => h.slice(0, 18)).join(", ")}
              </p>
              {detail.funding?.fundingExplorerUrl ? (
                <p style={{ margin: "8px 0 0", fontSize: 14 }}>
                  Funding evidence:{" "}
                  <a href={detail.funding.fundingExplorerUrl} target="_blank" rel="noreferrer">
                    view on Arc explorer ↗
                  </a>
                </p>
              ) : (
                detail.funding?.fundingTxHash && (
                  <p style={{ margin: "8px 0 0", fontSize: 14 }}>
                    Funding tx: <code style={{ fontSize: 12 }}>{detail.funding.fundingTxHash.slice(0, 18)}…</code>
                  </p>
                )
              )}
            </Card>
          </>
        )}
      </div>
    </main>
  );
}
