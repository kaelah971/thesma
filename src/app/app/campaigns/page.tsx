import type { Metadata } from "next";
import Link from "next/link";
import { NoWorkspace } from "@/components/app/NoWorkspace";
import { Card, EmptyState, PageHeader, Pill, ProgressBar } from "@/components/app/ui";
import styles from "@/components/app/app.module.css";
import { campaignName, formatDate, formatUsdc } from "@/lib/format";
import { CAMPAIGN_STATE_TONE, campaignFinancials, verifiedCount } from "@/lib/readmodel";
import { requireWorkspace } from "../data";

export const metadata: Metadata = { title: "Campaigns" };

export default async function CampaignsPage() {
  const { snapshot } = await requireWorkspace();
  if (!snapshot) return <NoWorkspace />;

  return (
    <>
      <PageHeader
        eyebrow={snapshot.workspace.name}
        title="Campaigns"
        description="Each campaign is an owner-approved policy: the outcome, budget, price range, minimum purchase, deadline and hold."
        actions={
          <Link href="/app/campaigns/new" className="btn btn-primary">
            New campaign
          </Link>
        }
      />
      <Card>
        {snapshot.campaigns.length === 0 ? (
          <EmptyState
            title="No campaigns yet"
            body="Start with one sentence describing the outcome and your limits."
            action={
              <Link href="/app/campaigns/new" className="btn btn-primary btn-sm">
                Draft a campaign
              </Link>
            }
          />
        ) : (
          <div className={styles.tableWrap} style={{ marginTop: -22 }}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>State</th>
                  <th>Progress</th>
                  <th className={styles.num}>Price range</th>
                  <th className={styles.num}>Available</th>
                  <th>Deadline</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.campaigns.map((c) => {
                  const f = campaignFinancials(c.id, snapshot);
                  const verified = verifiedCount(snapshot, c.id);
                  return (
                    <tr key={c.id}>
                      <td>
                        <div className={styles.cellTitle}>
                          <Link href={`/app/campaigns/${c.id}`} className={styles.truncate}>
                            {campaignName(c.intentText)}
                          </Link>
                          <small>
                            Policy v{c.version ?? "—"} · {c.visibility.toLowerCase()}
                          </small>
                        </div>
                      </td>
                      <td>
                        <Pill tone={CAMPAIGN_STATE_TONE[c.state]}>{c.state}</Pill>
                      </td>
                      <td style={{ minWidth: 160 }}>
                        <div className={styles.cellTitle}>
                          <small className="tnum">
                            {verified}
                            {c.targetOutcomeCount ? ` / ${c.targetOutcomeCount}` : ""} verified
                          </small>
                          <ProgressBar value={verified} max={c.targetOutcomeCount ?? 0} label="Verified outcomes" />
                        </div>
                      </td>
                      <td className={styles.num}>
                        {c.floorMicro && c.ceilingMicro ? `${formatUsdc(c.floorMicro)} – ${formatUsdc(c.ceilingMicro)}` : "—"}
                      </td>
                      <td className={styles.num}>{f.funded > 0n ? `${formatUsdc(f.available)} USDC` : <span className={styles.muted}>Not funded</span>}</td>
                      <td className={styles.muted}>{formatDate(c.deadline)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
