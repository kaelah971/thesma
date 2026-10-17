import Link from "next/link";
import { ActivityTimeline, HoldList, Pipeline } from "@/components/app/DataViews";
import { NoWorkspace } from "@/components/app/NoWorkspace";
import { Card, EmptyState, Kpi, PageHeader, Pill, ProgressBar } from "@/components/app/ui";
import styles from "@/components/app/app.module.css";
import { campaignName, formatUsdc } from "@/lib/format";
import {
  CAMPAIGN_STATE_TONE,
  campaignFinancials,
  outcomeRows,
  stageCounts,
  verifiedCount,
  workspaceFinancials,
} from "@/lib/readmodel";
import { requireWorkspace } from "./data";

export default async function OverviewPage() {
  const { snapshot } = await requireWorkspace();
  if (!snapshot) return <NoWorkspace />;

  const now = Date.parse(snapshot.generatedAt);
  const totals = workspaceFinancials(snapshot);
  const rows = outcomeRows(snapshot, now);
  const counts = stageCounts(rows);
  const holds = rows.filter((r) => r.stage === "SAFETY_HOLD").sort((a, b) => (a.holdRemainingMs ?? 0) - (b.holdRemainingMs ?? 0));
  const settledPayouts = snapshot.payouts.filter((p) => p.state === "SETTLED").length;
  const live = snapshot.campaigns.filter((c) => c.state === "LIVE").length;

  return (
    <>
      <PageHeader
        eyebrow={snapshot.workspace.name}
        title="Overview"
        description={
          snapshot.campaigns.length
            ? `${live} live of ${snapshot.campaigns.length} campaign${snapshot.campaigns.length === 1 ? "" : "s"} · ${holds.length} in safety hold`
            : "Define the outcome you'll pay for, fund it, and watch verified results settle."
        }
        actions={
          <>
            <Link href="/app/operator" className="btn btn-quiet">
              Ask operator
            </Link>
            <Link href="/app/campaigns/new" className="btn btn-primary">
              New campaign
            </Link>
          </>
        }
      />

      <div className={styles.kpis}>
        <Kpi label="Budget funded" value={formatUsdc(totals.funded)} unit="USDC" tone="lav" hint="Confirmed onchain only" />
        <Kpi label="Available budget" value={formatUsdc(totals.available)} unit="USDC" tone="blue" hint={`${formatUsdc(totals.committed)} USDC committed`} />
        <Kpi label="Verified outcomes" value={String(verifiedCount(snapshot))} tone="mint" hint={`${counts.AWAITING_VERIFICATION} awaiting verification`} />
        <Kpi label="Settled payouts" value={String(settledPayouts)} tone="cream" hint={`${formatUsdc(totals.settled)} USDC reconciled`} />
      </div>

      <div className={styles.grid2}>
        <Card
          title="Campaigns"
          action={
            <Link href="/app/campaigns" className={styles.cardLink}>
              View all
            </Link>
          }
        >
          {snapshot.campaigns.length === 0 ? (
            <EmptyState
              title="No campaigns yet"
              body="Describe the business outcome you want, with budget and limits. Thesma prepares a draft policy for you to review."
              action={
                <Link href="/app/campaigns/new" className="btn btn-primary btn-sm">
                  Draft a campaign
                </Link>
              }
            />
          ) : (
            <ul className={styles.campaignList}>
              {snapshot.campaigns.slice(0, 5).map((c) => {
                const f = campaignFinancials(c.id, snapshot);
                const verified = verifiedCount(snapshot, c.id);
                return (
                  <li key={c.id}>
                    <Link href={`/app/campaigns/${c.id}`} className={styles.campaignRow}>
                      <span className={styles.campaignName}>{campaignName(c.intentText)}</span>
                      <Pill tone={CAMPAIGN_STATE_TONE[c.state]}>{c.state}</Pill>
                      <div className={styles.campaignMeta}>
                        <div>
                          <span className="tnum">
                            {verified}
                            {c.targetOutcomeCount ? ` of ${c.targetOutcomeCount}` : ""} verified
                          </span>
                          <ProgressBar value={verified} max={c.targetOutcomeCount ?? 0} label="Verified outcomes" />
                        </div>
                        <span className="tnum">
                          {f.funded > 0n ? `${formatUsdc(f.available)} / ${formatUsdc(f.funded)} USDC available` : "Not funded"}
                        </span>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <div className={styles.stack}>
          <Card title="Settlement pipeline">
            <Pipeline counts={counts} />
          </Card>
          <Card title="Safety holds" tone="cream">
            {holds.length ? (
              <HoldList rows={holds.slice(0, 4)} campaigns={snapshot.campaigns} />
            ) : (
              <p className={styles.muted} style={{ fontSize: 14 }}>
                No verified outcomes are waiting out a hold. Payouts only move after the campaign&apos;s hold window passes.
              </p>
            )}
          </Card>
        </div>
      </div>

      <Card
        title="Recent activity"
        action={
          <Link href="/app/activity" className={styles.cardLink}>
            Full history
          </Link>
        }
      >
        {snapshot.activity.length ? (
          <ActivityTimeline items={snapshot.activity.slice(0, 8)} now={now} campaigns={snapshot.campaigns} />
        ) : (
          <EmptyState title="No activity yet" body="Every policy, funding, verification and payout event will be recorded here." />
        )}
      </Card>
    </>
  );
}
