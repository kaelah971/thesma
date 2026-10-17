import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { NoWorkspace } from "@/components/app/NoWorkspace";
import { Card, Facts, PageHeader, Pill } from "@/components/app/ui";
import styles from "@/components/app/app.module.css";
import { Rail } from "@/components/ui/Rail";
import { campaignName, formatDateTime, formatUsdc, shortHash } from "@/lib/format";
import { PAYOUT_STATE_TONE, RAIL } from "@/lib/readmodel";
import { arcConfigFromEnv } from "@/server/chain/arc";
import { createDrizzleCampaignStore } from "@/server/services/campaignStore.drizzle";
import { getPayoutReceipt } from "@/server/services/payouts";
import { requireWorkspace } from "../../data";

export const metadata: Metadata = { title: "Payout receipt" };

const RAIL_INDEX: Record<string, number> = { PREPARED: 2, SUBMITTED: 3, AMBIGUOUS: 3, FAILED: 3, SETTLED: 4 };
const CHECK_LABELS: Record<string, string> = {
  policyFunded: "Campaign policy was funded onchain",
  amountMatchesTerms: "Amount matches the partner's frozen terms",
  recipientMatchesWallet: "Recipient matches the registered payout wallet",
  holdCleared: "Safety hold had cleared",
};

function explorerBase() {
  try {
    return arcConfigFromEnv()?.explorerBaseUrl ?? null;
  } catch {
    return null;
  }
}

export default async function PayoutReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { snapshot } = await requireWorkspace();
  if (!snapshot) return <NoWorkspace />;
  const scoped = snapshot.payouts.find((p) => p.id === id);
  if (!scoped) notFound();

  const receipt = await getPayoutReceipt(createDrizzleCampaignStore(), { payoutId: id }, { explorerBaseUrl: explorerBase() });
  const { payout } = receipt;
  const campaign = snapshot.campaigns.find((c) => c.id === scoped.campaignId);
  const stateLabel = payout.state === "AMBIGUOUS" ? "Reconciling" : payout.state.charAt(0) + payout.state.slice(1).toLowerCase();

  return (
    <>
      <PageHeader
        back={{ href: "/app/payouts", label: "Payouts" }}
        eyebrow={campaign ? campaignName(campaign.intentText) : undefined}
        title={
          <>
            Receipt <span className="mono" style={{ fontSize: "0.6em", fontWeight: 500 }}>{payout.id.slice(0, 8)}</span>
          </>
        }
        actions={
          receipt.explorerUrl && (
            <a href={receipt.explorerUrl} target="_blank" rel="noreferrer" className="btn btn-quiet">
              View transaction
            </a>
          )
        }
      />

      <div className={styles.receipt}>
        <div className={styles.stack}>
          <Card>
            <Pill tone={PAYOUT_STATE_TONE[payout.state]}>{stateLabel}</Pill>
            <div className={styles.receiptAmount}>
              <strong className="tnum">{formatUsdc(payout.amountMicroUsdc)}</strong>
              <span>USDC</span>
            </div>
            <div className={styles.railCard}>
              <Rail
                steps={RAIL.map((s) => s.label)}
                current={RAIL_INDEX[payout.state] ?? 2}
                complete={payout.state === "SETTLED"}
                tone={payout.state === "FAILED" ? "rose" : payout.state === "AMBIGUOUS" ? "cream" : "lav"}
              />
            </div>
            <div className={styles.notice} data-tone={receipt.settledMeansReconciled ? "mint" : payout.state === "FAILED" ? "rose" : "cream"} style={{ marginTop: 18 }}>
              {receipt.settledMeansReconciled
                ? "Settled: reconciliation matched the vault, outcome, recipient, amount and proof in an onchain OutcomePaid event."
                : payout.state === "SUBMITTED"
                  ? "Submitted: broadcast once, awaiting reconciliation. Not yet called settled."
                  : payout.state === "AMBIGUOUS"
                    ? "Reconciling: the chain result couldn't be matched yet. Thesma reconciles before any retry and never resends blindly."
                    : payout.state === "FAILED"
                      ? `Failed${payout.failureCode ? ` (${payout.failureCode})` : ""}: the reservation was released and budget returned to available.`
                      : "Prepared: budget is reserved at the frozen price. Awaiting a signed broadcast."}
            </div>
          </Card>

          <Card title="Live checks">
            <ul className={styles.checks}>
              {Object.entries(receipt.checks).map(([key, ok]) => (
                <li key={key} data-ok={String(ok)}>
                  {CHECK_LABELS[key] ?? key}
                </li>
              ))}
            </ul>
            <p className={styles.muted} style={{ fontSize: 13, marginTop: 12 }}>
              Checks are recomputed each time this receipt is opened.
            </p>
          </Card>
        </div>

        <div className={styles.stack}>
          <Card title="Settlement">
            <Facts
              columns={1}
              items={[
                { label: "Recipient", value: <span className="mono">{payout.recipient}</span> },
                { label: "Transaction", value: <span className="mono">{payout.txHash ?? "Not broadcast"}</span> },
                { label: "Block", value: payout.blockNumber ?? "—" },
                { label: "Submitted", value: formatDateTime(payout.submittedAt) },
                { label: "Settled", value: formatDateTime(payout.settledAt) },
                { label: "Reconciled", value: formatDateTime(payout.reconciledAt) },
              ]}
            />
          </Card>
          <Card title="Evidence">
            <Facts
              columns={1}
              items={[
                { label: "Proof hash", value: <span className="mono">{shortHash(payout.proofHash, 12, 8)}</span> },
                { label: "Outcome", value: receipt.outcome ? `${receipt.outcome.status.toLowerCase()} · ${formatDateTime(receipt.outcome.verifiedAt)}` : "—" },
                { label: "Hold until", value: formatDateTime(receipt.outcome?.holdUntil) },
                {
                  label: "Frozen terms",
                  value: receipt.terms
                    ? `${formatUsdc(receipt.terms.priceMicroUsdc)} USDC · ${receipt.terms.source.toLowerCase()} · policy v${receipt.terms.policyVersion}`
                    : "—",
                },
                { label: "Reservation", value: receipt.reservation ? receipt.reservation.state.toLowerCase() : "—" },
              ]}
            />
            {campaign && (
              <Link href={`/app/campaigns/${campaign.id}`} className={styles.cardLink} style={{ display: "inline-block", marginTop: 14 }}>
                Open campaign →
              </Link>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
