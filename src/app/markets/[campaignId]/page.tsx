import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { getPublicMarketDetail } from "@/server/services/markets";
import { LogoMark } from "@/components/brand/Logo";
import { EvidenceHash } from "@/components/proof/EvidenceHash";
import { LifecycleStrip } from "@/components/proof/LifecycleStrip";
import { deriveLifecycle } from "@/components/proof/lifecycle";
import { TruthNote } from "@/components/proof/TruthNote";
import { PageHeader, Pill } from "@/components/app/ui";
import { formatDate, formatDateTime, formatUsdc } from "@/lib/format";

export const metadata: Metadata = { title: "Market" };

function LedgerBlock({
  title,
  status,
  amount,
  children,
}: {
  title: string;
  status?: React.ReactNode;
  amount?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={title}
      style={{
        borderTop: "1px solid var(--line, #e5e5e5)",
        padding: "16px 0",
        display: "grid",
        gap: 10,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <h3 style={{ margin: 0, fontSize: 15, display: "inline-flex", alignItems: "center", gap: 8 }}>
          {title} {status}
        </h3>
        {amount && (
          <p className="tnum" style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>
            {amount}
          </p>
        )}
      </div>
      {children}
    </section>
  );
}

function EvidenceRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
        fontSize: 13.5,
      }}
    >
      <span style={{ opacity: 0.65, flexShrink: 0 }}>{label}</span>
      <span style={{ minWidth: 0, textAlign: "right" }}>{children}</span>
    </div>
  );
}

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
  const done = detail.kind === "completed" ? detail : null;
  const settledCount = done ? done.payouts.filter((p) => p.state === "SETTLED").length : 0;
  const steps = deriveLifecycle({
    fundingStatus: detail.funding?.status ?? null,
    verifiedOutcomes: detail.verifiedOutcomes,
    settledPayouts: settledCount,
    purchaseCount: done ? done.purchaseTxs.length : undefined,
    fundedAmount:
      detail.funding?.observedMicroUsdc || detail.funding?.expectedMicroUsdc
        ? `${formatUsdc((detail.funding.observedMicroUsdc ?? detail.funding.expectedMicroUsdc)!)} USDC`
        : null,
    verifiedRevenue:
      done && done.verifiedRevenueMicroUsdc ? `${formatUsdc(done.verifiedRevenueMicroUsdc)} USDC` : null,
    settledTotal:
      done && settledCount > 0 ? `${formatUsdc(done.settledPayoutTotalMicroUsdc)} USDC` : null,
    target: detail.progress.target,
  });
  const heroAmount = done ? formatUsdc(done.settledPayoutTotalMicroUsdc) : formatUsdc(detail.publicBountyMicroUsdc);
  const heroLabel = done ? "Settled to partners" : "Public bounty per verified outcome";
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
              {done && done.completionReason === "TARGET_SETTLED" ? (
                <Pill tone="dark">Target reached · Settled</Pill>
              ) : (
                <>
                  <Pill tone={detail.live ? "mint" : "neutral"}>{detail.state}</Pill> <Pill>{detail.marketStatus}</Pill>
                </>
              )}
            </>
          }
          description={detail.objective}
        />

        <section
          aria-label="Market summary"
          style={{
            border: "1px solid var(--line, #e5e5e5)",
            borderRadius: 18,
            background: "var(--surface, #fff)",
            padding: "24px 24px 20px",
            display: "grid",
            gap: 16,
          }}
        >
          <div>
            <p className="tnum" style={{ margin: 0, fontSize: "clamp(30px, 8vw, 44px)", fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.05, overflowWrap: "anywhere" }}>
              {heroAmount}{" "}
              <span style={{ fontSize: 16, fontWeight: 500, opacity: 0.65 }}>USDC</span>
            </p>
            <p style={{ margin: "4px 0 0", fontSize: 13.5, opacity: 0.75 }}>{heroLabel}</p>
          </div>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "8px 28px",
              borderTop: "1px solid var(--line, #e5e5e5)",
              paddingTop: 14,
              fontSize: 13.5,
            }}
          >
            <span>
              Budget{" "}
              <strong className="tnum">
                {detail.approvedBudgetMicroUsdc ? `${formatUsdc(detail.approvedBudgetMicroUsdc)} USDC` : "—"}
              </strong>
            </span>
            <span>
              Verified{" "}
              <strong className="tnum">
                {detail.progress.verified}
                {detail.progress.target != null ? ` / ${detail.progress.target}` : ""}
              </strong>
            </span>
            <span>
              Partners <strong className="tnum">{detail.participatingPartners}</strong>
            </span>
            <span>
              Deadline <strong>{detail.deadline ? formatDate(detail.deadline) : "—"}</strong>
            </span>
          </div>
          <div style={{ borderTop: "1px solid var(--line, #e5e5e5)", paddingTop: 16 }}>
            <LifecycleStrip steps={steps} label={`${detail.workspaceName} lifecycle`} />
          </div>
        </section>

        <div aria-label="Proof ledger">
          <h2 style={{ fontSize: 18, margin: "0 0 4px" }}>Proof ledger</h2>
          <LedgerBlock
            title="Funding"
            status={
              detail.funding ? (
                <Pill tone={detail.funding.status === "CONFIRMED" ? "mint" : "blue"}>{detail.funding.status}</Pill>
              ) : undefined
            }
            amount={
              detail.funding
                ? `${formatUsdc(detail.funding.observedMicroUsdc ?? detail.funding.expectedMicroUsdc)} USDC`
                : undefined
            }
          >
            {detail.funding ? (
              <>
                {detail.funding.fundingTxHash && (
                  <EvidenceRow label="Funding transaction">
                    <EvidenceHash value={detail.funding.fundingTxHash} explorerUrl={detail.funding.fundingExplorerUrl} />
                  </EvidenceRow>
                )}
                {detail.funding.blockNumber != null && (
                  <EvidenceRow label="Block">
                    <span className="tnum">{detail.funding.blockNumber}</span>
                  </EvidenceRow>
                )}
              </>
            ) : (
              <p style={{ margin: 0, fontSize: 13.5, opacity: 0.7 }}>Not funded yet.</p>
            )}
          </LedgerBlock>

          {done && done.purchaseTxs.length > 0 && (
            <LedgerBlock
              title="Customer purchases"
              amount={`${formatUsdc(done.verifiedRevenueMicroUsdc ?? "0")} USDC verified revenue`}
            >
              <div style={{ display: "grid", gap: 10 }}>
                {done.purchaseTxs.map((t) => (
                  <EvidenceRow key={t.txHash} label={`${formatUsdc(t.amountMicroUsdc)} USDC · ${t.status}`}>
                    <EvidenceHash value={t.txHash} explorerUrl={t.explorerUrl} label={`Copy purchase transaction ${t.txHash.slice(0, 12)}`} />
                  </EvidenceRow>
                ))}
              </div>
            </LedgerBlock>
          )}

          {done && (
            <LedgerBlock title="Verification proof" amount={`${done.outcomeProofs.length} proof hash${done.outcomeProofs.length === 1 ? "" : "es"}`}>
              {done.outcomeProofs.length === 0 ? (
                <p style={{ margin: 0, fontSize: 13.5, opacity: 0.7 }}>No proof hashes recorded.</p>
              ) : (
                <div style={{ display: "grid", gap: 10 }}>
                  {done.outcomeProofs.map((h) => (
                    <EvidenceRow key={h} label="Proof hash">
                      <EvidenceHash value={h} label={`Copy proof hash ${h.slice(0, 12)}`} />
                    </EvidenceRow>
                  ))}
                </div>
              )}
            </LedgerBlock>
          )}

          {done && (
            <LedgerBlock
              title="Payouts"
              amount={`${formatUsdc(done.settledPayoutTotalMicroUsdc)} USDC settled`}
            >
              {done.payouts.length === 0 ? (
                <p style={{ margin: 0, fontSize: 13.5, opacity: 0.7 }}>No payouts recorded.</p>
              ) : (
                <div style={{ display: "grid", gap: 12 }}>
                  {done.payouts.map((p) => (
                    <div key={p.id} style={{ display: "grid", gap: 6 }}>
                      <p style={{ margin: 0, fontSize: 13.5 }}>
                        <strong className="tnum">{formatUsdc(p.amountMicroUsdc)} USDC</strong> · {p.state}
                        {p.settledAt && <> · settled {formatDateTime(p.settledAt)}</>}
                      </p>
                      <EvidenceRow label="Recipient">
                        <EvidenceHash value={p.recipient} label={`Copy recipient ${p.recipient.slice(0, 12)}`} />
                      </EvidenceRow>
                      {p.txHash && (
                        <EvidenceRow label="Payout transaction">
                          <EvidenceHash value={p.txHash} explorerUrl={p.explorerUrl} label={`Copy payout transaction ${p.txHash.slice(0, 12)}`} />
                        </EvidenceRow>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </LedgerBlock>
          )}

          {(!done || done.payouts.length === 0) && (
            <LedgerBlock title="Payouts">
              <p style={{ margin: 0, fontSize: 13.5, opacity: 0.7 }}>
                No payouts recorded yet. Verified outcomes are not paid until the safety hold clears and the payout is reconciled onchain.
              </p>
            </LedgerBlock>
          )}

          {done && (
            <LedgerBlock
              title="Settlement"
              amount={`${formatUsdc(done.settledPayoutTotalMicroUsdc)} USDC settled`}
            >
              <EvidenceRow label="Verified revenue">
                <span className="tnum">{done.verifiedRevenueMicroUsdc ? `${formatUsdc(done.verifiedRevenueMicroUsdc)} USDC` : "—"}</span>
              </EvidenceRow>
              <EvidenceRow label="Realized CAC">
                <span className="tnum">{done.realizedCacMicroUsdc ? `${formatUsdc(done.realizedCacMicroUsdc)} USDC` : "—"}</span>
              </EvidenceRow>
              <EvidenceRow label="Remaining budget">
                <span className="tnum">{done.remainingMicroUsdc ? `${formatUsdc(done.remainingMicroUsdc)} USDC` : "—"}</span>
              </EvidenceRow>
            </LedgerBlock>
          )}
        </div>

        <TruthNote items={done ? done.displayNotes : undefined} />

        {detail.latestAgentDecision && (
          <section aria-label="Autonomous decision" style={{ fontSize: 13.5, opacity: 0.8 }}>
            <p style={{ margin: 0 }}>
              <strong>Latest agent decision:</strong> {detail.latestAgentDecision.decision} · pace{" "}
              {detail.latestAgentDecision.paceState} · {detail.latestAgentDecision.reasonCodes.join(", ") || "no reason codes"} ·{" "}
              {formatDateTime(detail.latestAgentDecision.createdAt)}
            </p>
          </section>
        )}

        <details
          style={{
            border: "1px solid var(--line, #e5e5e5)",
            borderRadius: 12,
            padding: "12px 16px",
            fontSize: 13.5,
          }}
        >
          <summary style={{ cursor: "pointer", fontWeight: 600 }}>Campaign terms and policy</summary>
          <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
            <EvidenceRow label="Qualifying purchase">
              <span className="tnum">{detail.qualificationRule ? `${formatUsdc(detail.qualificationRule)} USDC` : "—"}</span>
            </EvidenceRow>
            <EvidenceRow label="Floor / ceiling">
              <span className="tnum">
                {detail.bountyFloorMicroUsdc ? formatUsdc(detail.bountyFloorMicroUsdc) : "—"} /{" "}
                {detail.bountyCeilingMicroUsdc ? formatUsdc(detail.bountyCeilingMicroUsdc) : "—"} USDC
              </span>
            </EvidenceRow>
            <EvidenceRow label="Deadline">
              <span>{detail.deadline ? formatDateTime(detail.deadline) : "—"}</span>
            </EvidenceRow>
            <EvidenceRow label="Funding state">
              <span>{detail.funding ? detail.funding.status : "Not funded"}</span>
            </EvidenceRow>
            <EvidenceRow label="Campaign started">
              <span>{formatDateTime(detail.startedAt)}</span>
            </EvidenceRow>
          </div>
        </details>
      </div>
    </main>
  );
}
