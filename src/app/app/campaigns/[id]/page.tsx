import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CampaignActions } from "@/components/app/CampaignActions";
import { CampaignFunding } from "@/components/app/CampaignFunding";
import { HoldList, OutcomeTable, PayoutTable, Pipeline } from "@/components/app/DataViews";
import { NoWorkspace } from "@/components/app/NoWorkspace";
import { Card, EmptyState, Facts, Kpi, PageHeader, Pill } from "@/components/app/ui";
import styles from "@/components/app/app.module.css";
import { campaignName, formatDate, formatDateTime, formatHoldSeconds, formatUsdc, shortHash } from "@/lib/format";
import {
  CAMPAIGN_STATE_TONE,
  campaignFinancials,
  FUNDING_STATE_TONE,
  outcomeRows,
  stageCounts,
  verifiedCount,
} from "@/lib/readmodel";
import { requireWorkspace } from "../../data";

export const metadata: Metadata = { title: "Campaign" };

const REQUIRED: { key: "targetOutcomeCount" | "budgetMicro" | "floorMicro" | "ceilingMicro" | "minPurchaseMicro" | "deadline"; label: string }[] = [
  { key: "targetOutcomeCount", label: "target count" },
  { key: "budgetMicro", label: "budget" },
  { key: "floorMicro", label: "floor" },
  { key: "ceilingMicro", label: "maximum per outcome" },
  { key: "minPurchaseMicro", label: "minimum purchase" },
  { key: "deadline", label: "deadline" },
];

const usdc = (v: string | null) => (v ? `${formatUsdc(v)} USDC` : "Missing");

export default async function CampaignPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id } = await params;
  const { drafted } = await searchParams;
  const { snapshot } = await requireWorkspace();
  if (!snapshot) return <NoWorkspace />;
  const campaign = snapshot.campaigns.find((c) => c.id === id);
  if (!campaign) notFound();

  const now = Date.parse(snapshot.generatedAt);
  const arcChainId = Number.parseInt(process.env.ARC_CHAIN_ID ?? "5042", 10);
  const f = campaignFinancials(campaign.id, snapshot);
  const rows = outcomeRows(snapshot, now, campaign.id);
  const counts = stageCounts(rows);
  const holds = rows.filter((r) => r.stage === "SAFETY_HOLD").sort((a, b) => (a.holdRemainingMs ?? 0) - (b.holdRemainingMs ?? 0));
  const payouts = snapshot.payouts.filter((p) => p.campaignId === campaign.id);
  const missing = REQUIRED.filter((r) => campaign[r.key] === null);
  const verified = verifiedCount(snapshot, campaign.id);
  const pct = (v: bigint) => (f.funded > 0n ? `${Number((v * 10000n) / f.funded) / 100}%` : "0%");

  return (
    <>
      <PageHeader
        back={{ href: "/app/campaigns", label: "Campaigns" }}
        eyebrow={
          <>
            <Pill tone={CAMPAIGN_STATE_TONE[campaign.state]}>{campaign.state}</Pill>{" "}
            <span style={{ marginLeft: 6 }}>
              Policy v{campaign.version ?? "—"} · {campaign.policyStatus?.toLowerCase()}
            </span>
          </>
        }
        title={campaignName(campaign.intentText)}
        actions={
          campaign.version !== null && (
            <CampaignActions
              campaignId={campaign.id}
              state={campaign.state}
              version={campaign.version}
              isOwner={snapshot.workspace.role === "ORGANIZATION_OWNER"}
              ready={missing.length === 0}
            />
          )
        }
      />

      {drafted && (
        <div className={styles.notice} data-tone={missing.length ? "cream" : "mint"} style={{ marginBottom: 12 }}>
          {missing.length
            ? `Draft saved. Still missing: ${missing.map((m) => m.label).join(", ")}. Add them to your description in a new draft, or revise via the API.`
            : "Draft saved with every required field. Request review when you're ready."}
        </div>
      )}

      <div className={styles.kpis}>
        <Kpi label="Budget funded" value={formatUsdc(f.funded)} unit="USDC" tone="lav" hint={campaign.funding ? `Funding ${campaign.funding.status.toLowerCase()}` : "Not funded"} />
        <Kpi label="Available" value={formatUsdc(f.available)} unit="USDC" tone="blue" hint={`${formatUsdc(f.inFlight)} USDC in flight`} />
        <Kpi label="Verified outcomes" value={campaign.targetOutcomeCount ? `${verified}/${campaign.targetOutcomeCount}` : String(verified)} tone="mint" hint={`${counts.AWAITING_VERIFICATION} awaiting verification`} />
        <Kpi label="Settled" value={formatUsdc(f.settled)} unit="USDC" tone="cream" hint={`${counts.SETTLED} payout${counts.SETTLED === 1 ? "" : "s"} reconciled`} />
      </div>

      <div className={styles.grid2}>
        <div className={styles.stack}>
          <Card title="Policy">
            <blockquote className={styles.intent}>{campaign.intentText}</blockquote>
            <Facts
              items={[
                { label: "Target outcomes", value: campaign.targetOutcomeCount ?? "Missing" },
                { label: "Budget", value: usdc(campaign.budgetMicro) },
                { label: "Price floor", value: usdc(campaign.floorMicro) },
                { label: "Price ceiling", value: usdc(campaign.ceilingMicro) },
                { label: "Minimum purchase", value: usdc(campaign.minPurchaseMicro) },
                { label: "Deadline", value: campaign.deadline ? formatDate(campaign.deadline) : "Missing" },
                { label: "Safety hold", value: formatHoldSeconds(campaign.refundHoldSeconds) },
                { label: "Visibility", value: campaign.visibility === "PUBLIC" ? "Public market" : "Private (invite only)" },
              ]}
            />
          </Card>

          <Card title="Budget">
            <div className={styles.budgetBar} aria-hidden="true">
              <i style={{ width: pct(f.settled), background: "var(--ink)" }} />
              <i style={{ width: pct(f.inFlight), background: "var(--lav-ink)" }} />
            </div>
            <div className={styles.legend}>
              <span>
                <i style={{ background: "var(--ink)" }} />
                Settled {formatUsdc(f.settled)}
              </span>
              <span>
                <i style={{ background: "var(--lav-ink)" }} />
                Committed, not settled {formatUsdc(f.inFlight)}
              </span>
              <span>
                <i style={{ background: "var(--mint)" }} />
                Available {formatUsdc(f.available)}
              </span>
            </div>
            <p className={styles.muted} style={{ fontSize: 13, marginTop: 14 }}>
              Available = confirmed funding − active reservations − accepted negotiation commitments. Settled payouts stay committed.
            </p>
          </Card>
        </div>

        <div className={styles.stack}>
          <Card title="Funding">
            {campaign.funding ? (
              <>
                <Facts
                  columns={1}
                  items={[
                    { label: "Status", value: <Pill tone={FUNDING_STATE_TONE[campaign.funding.status]}>{campaign.funding.status}</Pill> },
                    { label: "Amount", value: `${formatUsdc(campaign.funding.observedMicro ?? campaign.funding.expectedMicro)} USDC` },
                    { label: "Funding transaction", value: <span className="mono">{shortHash(campaign.funding.fundingTxHash, 10, 6)}</span> },
                    { label: "Confirmed", value: formatDateTime(campaign.funding.confirmedAt) },
                    ...(campaign.funding.failureCode ? [{ label: "Failure", value: <span className="mono">{campaign.funding.failureCode}</span> }] : []),
                  ]}
                />
                {campaign.version !== null && (
                  <div style={{ marginTop: 12 }}>
                    <CampaignFunding
                      campaignId={campaign.id}
                      version={campaign.version}
                      state={campaign.state}
                      isOwner={snapshot.workspace.role === "ORGANIZATION_OWNER"}
                      fundingStatus={campaign.funding.status}
                      expectedAmountMicro={campaign.funding.expectedMicro}
                      expectedSender={snapshot.workspace.companyWallet}
                      chainId={arcChainId}
                    />
                  </div>
                )}
              </>
            ) : campaign.state === "APPROVED" && campaign.version !== null ? (
              <CampaignFunding
                campaignId={campaign.id}
                version={campaign.version}
                state={campaign.state}
                isOwner={snapshot.workspace.role === "ORGANIZATION_OWNER"}
                fundingStatus={null}
                expectedAmountMicro={campaign.budgetMicro}
                expectedSender={snapshot.workspace.companyWallet}
                chainId={arcChainId}
              />
            ) : (
              <p className={styles.muted} style={{ fontSize: 14 }}>
                Funding opens once the policy is approved by the organization owner.
              </p>
            )}
          </Card>

          <Card title="Market">
            {campaign.market ? (
              <Facts
                columns={1}
                items={[
                  { label: "Current price", value: `${formatUsdc(campaign.market.bountyMicro)} USDC per outcome` },
                  { label: "Market status", value: campaign.market.status.replace(/_/g, " ").toLowerCase() },
                  { label: "Opened", value: formatDateTime(campaign.market.openedAt) },
                ]}
              />
            ) : (
              <p className={styles.muted} style={{ fontSize: 14 }}>
                The market opens after funding is confirmed. Partners can then join at the published price.
              </p>
            )}
          </Card>

          <Card title="Settlement pipeline">
            <Pipeline counts={counts} campaignId={campaign.id} />
          </Card>

          {holds.length > 0 && (
            <Card title="Safety holds" tone="cream">
              <HoldList rows={holds.slice(0, 3)} campaigns={snapshot.campaigns} />
            </Card>
          )}
        </div>
      </div>

      <div className={styles.stack}>
        <Card
          title="Outcomes"
          action={
            rows.length > 0 && (
              <Link href={`/app/outcomes?campaign=${campaign.id}`} className={styles.cardLink}>
                Filter outcomes
              </Link>
            )
          }
        >
          {rows.length ? (
            <OutcomeTable rows={rows.slice(0, 12)} campaigns={snapshot.campaigns} showCampaign={false} />
          ) : (
            <EmptyState title="No outcomes yet" body="Outcomes appear when a referred customer completes a qualifying purchase." />
          )}
        </Card>
        <Card title="Payouts">
          {payouts.length ? (
            <PayoutTable payouts={payouts.slice(0, 12)} campaigns={snapshot.campaigns} showCampaign={false} />
          ) : (
            <EmptyState title="No payouts yet" body="Payouts are created only for verified outcomes whose safety hold has passed." />
          )}
        </Card>
      </div>
    </>
  );
}
