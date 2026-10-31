import type { Metadata } from "next";
import Link from "next/link";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { getPublicMarketDetail } from "@/server/services/markets";
import { LogoMark } from "@/components/brand/Logo";
import { EvidenceHash } from "@/components/proof/EvidenceHash";
import { LifecycleStrip } from "@/components/proof/LifecycleStrip";
import { deriveLifecycle } from "@/components/proof/lifecycle";
import { Card, PageHeader, Pill } from "@/components/app/ui";
import { formatDateTime, formatUsdc } from "@/lib/format";
import {
  addressExplorerUrl,
  BEACONFIELD_CAMPAIGN_ID,
  buildDemoPayload,
  DEMO_CAMPAIGN_ID,
  explorerBaseUrl,
  sourcifyContractUrl,
  THESMA_VAULT_ADDRESS,
  txExplorerUrl,
  ARC_MAINNET_CHAIN_ID,
} from "@/lib/proof";

export const metadata: Metadata = {
  title: "Real proof",
  description:
    "Watch a real Thesma campaign settle on Arc Mainnet: funded, purchased, verified, held, paid and reconciled — no login required.",
  alternates: { canonical: "/demo" },
};

/** Runtime fetch; root layout already forces dynamic, stated here for intent. */
export const dynamic = "force-dynamic";

function Step({
  n,
  title,
  state,
  children,
}: {
  n: number;
  title: string;
  state: string;
  children: React.ReactNode;
}) {
  return (
    <li
      style={{
        border: "1px solid var(--line, #e5e5e5)",
        borderRadius: 18,
        background: "var(--surface, #fff)",
        padding: "20px 20px 16px",
        display: "grid",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <span
          aria-hidden="true"
          className="tnum"
          style={{
            width: 28,
            height: 28,
            borderRadius: 999,
            background: "var(--ink, #131417)",
            color: "#fff",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 13,
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          {n}
        </span>
        <h3 style={{ margin: 0, fontSize: 16 }}>{title}</h3>
        <span style={{ marginLeft: "auto" }}>
          <Pill tone={state === "SETTLED" || state === "CONFIRMED" || state === "VERIFIED" ? "mint" : "neutral"}>
            {state}
          </Pill>
        </span>
      </div>
      <div style={{ display: "grid", gap: 10, fontSize: 13.5 }}>{children}</div>
    </li>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
      <span style={{ opacity: 0.65, flexShrink: 0 }}>{label}</span>
      <span style={{ minWidth: 0, textAlign: "right" }}>{children}</span>
    </div>
  );
}

export default async function DemoPage() {
  const wired = marketDepsOr503();
  const base = explorerBaseUrl();
  if ("response" in wired) {
    return (
      <main style={{ minHeight: "100dvh", padding: "32px 16px 64px" }}>
        <div style={{ width: "100%", maxWidth: 960, margin: "0 auto", display: "grid", gap: 20 }}>
          <PageHeader eyebrow="No login required" title="Real proof" description="A real campaign, settled onchain." />
          <Card tone="blue">
            <p style={{ margin: 0, fontSize: 14 }}>
              Proof data is temporarily unavailable. The completed history lives on{" "}
              <Link href="/markets">public markets</Link>.
            </p>
          </Card>
        </div>
      </main>
    );
  }
  let detail;
  try {
    detail = await getPublicMarketDetail(wired.deps, { campaignId: DEMO_CAMPAIGN_ID, explorerBaseUrl: base });
  } catch {
    return (
      <main style={{ minHeight: "100dvh", padding: "32px 16px 64px" }}>
        <div style={{ width: "100%", maxWidth: 960, margin: "0 auto", display: "grid", gap: 20 }}>
          <PageHeader eyebrow="No login required" title="Real proof" description="A real campaign, settled onchain." />
          <Card tone="blue">
            <p style={{ margin: 0, fontSize: 14 }}>
              This proof is not published yet. See <Link href="/markets">public markets</Link> for what is.
            </p>
          </Card>
        </div>
      </main>
    );
  }
  // Settled language only from genuine settled truth — never from elapsed
  // time, submission, or verification alone.
  if (detail.kind !== "completed") {
    return (
      <main style={{ minHeight: "100dvh", padding: "32px 16px 64px" }}>
        <div style={{ width: "100%", maxWidth: 960, margin: "0 auto", display: "grid", gap: 20 }}>
          <PageHeader eyebrow="No login required" title="Real proof" description="A real campaign, settled onchain." />
          <Card tone="blue">
            <p style={{ margin: 0, fontSize: 14 }}>
              This campaign has not settled yet — settlement is only shown once onchain reconciliation confirms it.{" "}
              <Link href={`/markets/${DEMO_CAMPAIGN_ID}`}>View its live state</Link>.
            </p>
          </Card>
        </div>
      </main>
    );
  }
  const demo = buildDemoPayload(detail as unknown as Record<string, unknown>);
  const funding = demo.funding as {
    status: string; observedMicroUsdc: string | null; expectedMicroUsdc: string;
    fundingTxHash: string | null; fundingExplorerUrl: string | null; blockNumber: number | null;
  } | null;
  const purchases = (demo.purchaseTxs ?? []) as Array<{ txHash: string; explorerUrl: string | null; amountMicroUsdc: string; status: string }>;
  const proofs = (demo.outcomeProofs ?? []) as string[];
  const payouts = (demo.payouts ?? []) as Array<{
    id: string; recipient: string; amountMicroUsdc: string; state: string;
    txHash: string | null; explorerUrl: string | null; blockNumber: number | null; settledAt: string | null;
  }>;
  const settled = payouts.filter((p) => p.state === "SETTLED");
  const firstSettled = settled[0] ?? null;
  const steps = deriveLifecycle({
    fundingStatus: funding?.status ?? null,
    verifiedOutcomes: (demo.verifiedOutcomes as number) ?? 0,
    settledPayouts: settled.length,
    purchaseCount: purchases.length,
    fundedAmount: funding ? `${formatUsdc(funding.observedMicroUsdc ?? funding.expectedMicroUsdc)} USDC` : null,
    settledTotal: settled.length > 0 ? `${formatUsdc(demo.settledPayoutTotalMicroUsdc as string)} USDC` : null,
  });

  return (
    <main style={{ minHeight: "100dvh", padding: "32px 16px 64px" }}>
      <div style={{ width: "100%", maxWidth: 960, margin: "0 auto", display: "grid", gap: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Link href="/" aria-label="Thesma home">
            <LogoMark size={32} />
          </Link>
          <p style={{ margin: 0, fontWeight: 800, letterSpacing: 2, fontSize: 13 }}>THESMA · REAL PROOF</p>
        </div>

        <PageHeader
          back={{ href: "/", label: "Home" }}
          eyebrow="No login required · Read-only · No wallet needed"
          title={<>Watch a real campaign settle.</>}
          description="One real campaign on Arc Mainnet, from funding to reconciled settlement. Every hash below opens in the public explorer — nothing here is simulated."
        />

        <section aria-label="Public proof facts" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <Pill tone="mint">Arc Mainnet</Pill>
          <Pill tone="mint">Source verified</Pill>
          <Pill tone="mint">Real USDC</Pill>
          <Pill tone="mint">Real settlement</Pill>
          <Pill tone="mint">No-double-pay tested</Pill>
        </section>

        <section aria-label="Campaign lifecycle" style={{ display: "grid", gap: 12 }}>
          <LifecycleStrip steps={steps} label={`${demo.workspaceName as string} lifecycle`} />
        </section>

        <ol aria-label="How this campaign settled" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 12 }}>
          <Step n={1} title="Campaign created" state="APPROVED">
            <p style={{ margin: 0 }}>
              <strong>{demo.workspaceName as string}</strong> defined the outcome: {demo.objective as string}
            </p>
            <Fact label="Budget">
              <strong className="tnum">{formatUsdc(demo.approvedBudgetMicroUsdc as string)} USDC</strong>
            </Fact>
            <Fact label="Price per verified outcome">
              <strong className="tnum">{formatUsdc(demo.publicBountyMicroUsdc as string)} USDC</strong>
            </Fact>
            <Fact label="Qualifying purchase">
              <span className="tnum">{demo.qualificationRule ? `${formatUsdc(demo.qualificationRule as string)} USDC` : "—"}</span>
            </Fact>
          </Step>

          <Step n={2} title="Funded" state={funding?.status ?? "UNKNOWN"}>
            <p style={{ margin: 0 }}>
              The budget moved into the vault contract first — payouts can only come out of money already set aside.
            </p>
            {funding ? (
              <>
                <Fact label="Confirmed onchain">
                  <strong className="tnum">{formatUsdc(funding.observedMicroUsdc ?? funding.expectedMicroUsdc)} USDC</strong>
                </Fact>
                {funding.fundingTxHash && (
                  <Fact label="Funding transaction">
                    <EvidenceHash
                      value={funding.fundingTxHash}
                      explorerUrl={funding.fundingExplorerUrl ?? txExplorerUrl(funding.fundingTxHash, base)}
                      label={`Copy funding transaction ${funding.fundingTxHash.slice(0, 12)}`}
                    />
                  </Fact>
                )}
                <p style={{ margin: 0 }}>
                  <a href={funding.fundingTxHash ? (funding.fundingExplorerUrl ?? txExplorerUrl(funding.fundingTxHash, base)) : addressExplorerUrl(THESMA_VAULT_ADDRESS, base)} target="_blank" rel="noreferrer">
                    View funding transaction ↗
                  </a>
                </p>
              </>
            ) : (
              <p style={{ margin: 0 }}>Not funded yet.</p>
            )}
          </Step>

          <Step n={3} title="Customer action" state={purchases.length > 0 ? "RECORDED" : "PENDING"}>
            <p style={{ margin: 0 }}>A real customer paid the company — this is the action everything else checks.</p>
            {purchases.length === 0 ? (
              <p style={{ margin: 0 }}>No qualifying purchase recorded.</p>
            ) : (
              purchases.map((t) => (
                <Fact key={t.txHash} label={`${formatUsdc(t.amountMicroUsdc)} USDC paid`}>
                  <EvidenceHash
                    value={t.txHash}
                    explorerUrl={t.explorerUrl ?? txExplorerUrl(t.txHash, base)}
                    label={`Copy purchase transaction ${t.txHash.slice(0, 12)}`}
                  />
                </Fact>
              ))
            )}
          </Step>

          <Step n={4} title="Verified" state="VERIFIED">
            <p style={{ margin: 0 }}>
              The purchase passed the campaign&apos;s verification rule. Verified is not paid — it only means the
              evidence passed.
            </p>
            <Fact label="Verified revenue">
              <strong className="tnum">
                {demo.verifiedRevenueMicroUsdc ? `${formatUsdc(demo.verifiedRevenueMicroUsdc as string)} USDC` : "—"}
              </strong>
            </Fact>
            {proofs.map((h) => (
              <Fact key={h} label="Proof hash">
                <EvidenceHash value={h} label={`Copy proof hash ${h.slice(0, 12)}`} />
              </Fact>
            ))}
          </Step>

          <Step n={5} title="Safety hold" state="CLEARED">
            <p style={{ margin: 0 }}>
              Every campaign waits before money moves, so refunds and reversals surface first. This one waited{" "}
              <strong>
                {typeof demo.holdSeconds === "number" ? `${(demo.holdSeconds / 3600).toString()} hour${demo.holdSeconds === 3600 ? "" : "s"}` : "its policy hold"}
              </strong>{" "}
              after verification — the payout only became eligible once the hold genuinely expired.
            </p>
          </Step>

          <Step n={6} title="Payout" state={firstSettled ? "SUBMITTED" : "PENDING"}>
            <p style={{ margin: 0 }}>
              The payout was submitted exactly once through the production payout path. Submitted is not settled —
              only onchain reconciliation settles it.
            </p>
            {payouts.length === 0 ? (
              <p style={{ margin: 0 }}>No payouts recorded.</p>
            ) : (
              payouts.map((p) => (
                <div key={p.id} style={{ display: "grid", gap: 8, borderTop: "1px solid var(--line, #e5e5e5)", paddingTop: 10 }}>
                  <Fact label="Amount">
                    <strong className="tnum">{formatUsdc(p.amountMicroUsdc)} USDC · {p.state}</strong>
                  </Fact>
                  <Fact label="Recipient">
                    <EvidenceHash value={p.recipient} label={`Copy recipient ${p.recipient.slice(0, 12)}`} />
                  </Fact>
                  {p.txHash && (
                    <Fact label="Payout transaction">
                      <EvidenceHash
                        value={p.txHash}
                        explorerUrl={p.explorerUrl ?? txExplorerUrl(p.txHash, base)}
                        label={`Copy payout transaction ${p.txHash.slice(0, 12)}`}
                      />
                    </Fact>
                  )}
                </div>
              ))
            )}
          </Step>

          <Step n={7} title="Settled" state="SETTLED">
            <p style={{ margin: 0 }}>
              The payout receipt matched the outcome, the recipient and the exact amount — only then was it marked
              settled. A second processing run confirmed no duplicate payment.
            </p>
            <Fact label={`Settled to partners (${settled.length})`}>
              <strong className="tnum">{formatUsdc(demo.settledPayoutTotalMicroUsdc as string)} USDC</strong>
            </Fact>
            {firstSettled?.txHash && (
              <p style={{ margin: 0 }}>
                <a href={firstSettled.explorerUrl ?? txExplorerUrl(firstSettled.txHash, base)} target="_blank" rel="noreferrer">
                  View payout transaction ↗
                </a>
              </p>
            )}
            <Fact label="Realized cost per outcome">
              <span className="tnum">
                {demo.realizedCacMicroUsdc ? `${formatUsdc(demo.realizedCacMicroUsdc as string)} USDC` : "—"}
              </span>
            </Fact>
          </Step>
        </ol>

        {firstSettled && (
          <details
            style={{ border: "1px solid var(--line, #e5e5e5)", borderRadius: 12, padding: "12px 16px", fontSize: 13.5 }}
          >
            <summary style={{ cursor: "pointer", fontWeight: 700 }}>Why this payout happened</summary>
            <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
              <Fact label="Qualifying action">
                <span>
                  Customer purchase of {formatUsdc((purchases[0]?.amountMicroUsdc ?? demo.verifiedRevenueMicroUsdc ?? "0") as string)} USDC
                  {demo.qualificationRule ? ` (rule: at least ${formatUsdc(demo.qualificationRule as string)} USDC)` : ""}
                </span>
              </Fact>
              <Fact label="Verification result">
                <span>VERIFIED — evidence passed, proof hash recorded above</span>
              </Fact>
              <Fact label="Policy condition">
                <span>
                  {formatUsdc(demo.publicBountyMicroUsdc as string)} USDC per verified outcome, from a{" "}
                  {formatUsdc(demo.approvedBudgetMicroUsdc as string)} USDC confirmed budget
                </span>
              </Fact>
              <Fact label="Hold condition">
                <span>
                  {typeof demo.holdSeconds === "number" ? `${demo.holdSeconds}-second` : "Policy"} safety hold expired
                  before submission
                </span>
              </Fact>
              <Fact label="Amount">
                <strong className="tnum">{formatUsdc(firstSettled.amountMicroUsdc)} USDC</strong>
              </Fact>
              <Fact label="Settlement proof">
                {firstSettled.txHash ? (
                  <EvidenceHash
                    value={firstSettled.txHash}
                    explorerUrl={firstSettled.explorerUrl ?? txExplorerUrl(firstSettled.txHash, base)}
                    label={`Copy settlement transaction ${firstSettled.txHash.slice(0, 12)}`}
                  />
                ) : (
                  <span>—</span>
                )}
              </Fact>
              {firstSettled.settledAt && (
                <Fact label="Settled at">
                  <span>{formatDateTime(firstSettled.settledAt)}</span>
                </Fact>
              )}
            </div>
          </details>
        )}

        <section
          aria-label="Contract and network proof"
          style={{ border: "1px solid var(--line, #e5e5e5)", borderRadius: 18, background: "var(--surface, #fff)", padding: "20px", display: "grid", gap: 10, fontSize: 13.5 }}
        >
          <h2 style={{ margin: 0, fontSize: 16 }}>Independent verification</h2>
          <p style={{ margin: 0, opacity: 0.75 }}>
            The vault contract and every transaction above are public on Arc Mainnet (chain {ARC_MAINNET_CHAIN_ID}).
            Check them without trusting this page.
          </p>
          <Fact label="Vault contract">
            <EvidenceHash
              value={THESMA_VAULT_ADDRESS}
              explorerUrl={addressExplorerUrl(THESMA_VAULT_ADDRESS, base)}
              label="Copy vault contract address"
            />
          </Fact>
          <p style={{ margin: 0, display: "flex", gap: 16, flexWrap: "wrap" }}>
            <a href={addressExplorerUrl(THESMA_VAULT_ADDRESS, base)} target="_blank" rel="noreferrer">
              View contract ↗
            </a>
            <a href={sourcifyContractUrl()} target="_blank" rel="noreferrer">
              Verify contract source ↗
            </a>
          </p>
          <p style={{ margin: 0, fontSize: 12.5, opacity: 0.65 }}>
            Source verification: Sourcify exact_match. The explorer link above is the public address viewer.
          </p>
        </section>

        <section aria-label="More proof" style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 13.5 }}>
          <Link href={`/markets/${DEMO_CAMPAIGN_ID}`} className="btn btn-sm">
            View full ledger
          </Link>
          <Link href={`/markets/${BEACONFIELD_CAMPAIGN_ID}`} className="btn btn-sm">
            Second settled proof: Beaconfield
          </Link>
          <Link href="/markets#completed" className="btn btn-sm">
            All completed markets
          </Link>
        </section>

        <section
          aria-label="Run your own campaign"
          style={{ borderRadius: 18, background: "var(--ink, #131417)", color: "#fff", padding: "28px 24px", display: "grid", gap: 12 }}
        >
          <h2 style={{ margin: 0, fontSize: 21 }}>Run your own campaign on these rails.</h2>
          <p style={{ margin: 0, fontSize: 14, opacity: 0.8 }}>
            Same funding lock, same verification, same hold, same receipts. You just saw it work.
          </p>
          <div>
            <Link href="/start" className="btn btn-primary">
              Run your own campaign
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
