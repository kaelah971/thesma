import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CampaignActions } from "@/components/app/CampaignActions";
import { CampaignFunding } from "@/components/app/CampaignFunding";
import { CreatorMatchesPanel } from "@/components/app/CreatorMatches";
import { HoldList, OutcomeTable, PayoutTable, Pipeline } from "@/components/app/DataViews";
import { NoWorkspace } from "@/components/app/NoWorkspace";
import { Card, EmptyState, Facts, Kpi, PageHeader, Pill } from "@/components/app/ui";
import styles from "@/components/app/app.module.css";
import { campaignName, formatDate, formatDateTime, formatHoldSeconds, formatUsdc, shortHash } from "@/lib/format";
import { summarizeFunnel } from "@/server/services/markets";
import { getDb } from "@/server/db/client";
import { partnerTerms, partners, referralEvents, referrals, userPersonas, users } from "@/server/db/schema";
import { and, eq, inArray } from "drizzle-orm";
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

/** Real participant rows for one campaign: identity + referral + click count. */
async function loadParticipants(
  campaignId: string,
): Promise<{ partnerId: string; label: string; clicks: number }[]> {
  const db = getDb();
  const termRows = await db
    .select({ partnerId: partnerTerms.partnerId })
    .from(partnerTerms)
    .where(eq(partnerTerms.campaignId, campaignId));
  const partnerIds = [...new Set(termRows.map((t) => t.partnerId))];
  if (partnerIds.length === 0) return [];
  const [refRows, partnerRows] = await Promise.all([
    db.select().from(referrals).where(eq(referrals.campaignId, campaignId)),
    db.select({ id: partners.id, userId: partners.userId }).from(partners).where(inArray(partners.id, partnerIds)),
  ]);
  const clickRows =
    refRows.length > 0
      ? await db
          .select({ referralId: referralEvents.referralId })
          .from(referralEvents)
          .where(
            and(
              inArray(
                referralEvents.referralId,
                refRows.map((r) => r.id),
              ),
              eq(referralEvents.eventType, "CLICK"),
            ),
          )
      : [];
  const clicksByPartner = new Map<string, number>();
  for (const r of refRows) {
    const n = clickRows.filter((c) => c.referralId === r.id).length;
    clicksByPartner.set(r.partnerId, (clicksByPartner.get(r.partnerId) ?? 0) + n);
  }
  const userIds = [...new Set(partnerRows.map((p) => p.userId))];
  const [userRows, personaRows] =
    userIds.length > 0
      ? await Promise.all([
          db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds)),
          db
            .select({ userId: userPersonas.userId, handle: userPersonas.handle })
            .from(userPersonas)
            .where(inArray(userPersonas.userId, userIds)),
        ])
      : [[], []];
  const nameByUser = new Map(userRows.map((u) => [u.id, u.name]));
  const handleByUser = new Map(personaRows.map((p) => [p.userId, p.handle]));
  return partnerIds.map((partnerId) => {
    const userId = partnerRows.find((p) => p.id === partnerId)?.userId ?? null;
    const handle = userId ? handleByUser.get(userId) : null;
    const name = userId ? nameByUser.get(userId) : null;
    return {
      partnerId,
      label: handle ? `@${handle}` : name || "Creator",
      clicks: clicksByPartner.get(partnerId) ?? 0,
    };
  });
}

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

  // Participant funnel (real rows only): terms → referrals → clicks →
  // outcomes → payouts, identity from users/personas. Never ranked, never
  // fabricated — feeds the Organization AI in a later slice.
  const participants = await loadParticipants(id).catch(() => []);
  const snapOutcomes = snapshot.outcomes.filter((o) => o.campaignId === campaign.id);
  const snapPayouts = payouts;
  const participantRows = participants.map((p) => ({
    ...p,
    funnel: summarizeFunnel(
      {
        clicks: p.clicks,
        outcomes: snapOutcomes
          .filter((o) => o.partnerId === p.partnerId)
          .map((o) => ({ status: o.status, holdUntil: o.holdUntil ? new Date(o.holdUntil) : null })),
        settledPayoutMicroUsdc: snapPayouts
          .filter((q) => q.partnerId === p.partnerId && q.state === "SETTLED")
          .map((q) => BigInt(q.amountMicro)),
      },
      new Date(now),
    ),
  }));

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
            : snapshot.workspace.role === "ORGANIZATION_OWNER"
              ? "Draft saved with every required field. Review the terms below, then approve the campaign — no self-review needed."
              : "Draft saved with every required field. Request review so an owner can approve it."}
        </div>
      )}
      {campaign.state === "APPROVED" && !campaign.funding && (
        <div className={styles.notice} data-tone="mint" style={{ marginBottom: 12 }}>
          Approved — awaiting funding. You can match and invite creators now; customer acquisition and payouts begin after funding.
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
            ) : campaign.state === "APPROVED" ? (
              <p className={styles.muted} style={{ fontSize: 14 }}>
                <strong>Not active</strong> — awaiting funding. Funding is required before customer acquisition and payouts begin. You can already match and invite creators above; the market opens after funding is confirmed.
              </p>
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
        <Card title="Creator matches">
          <p className={styles.muted} style={{ fontSize: 13, marginTop: 0 }}>
            Ranked registered creators for this campaign with the reason behind each match. Inviting is not participation — no referral, payout, or notification is created.
            {campaign.state === "APPROVED" && !campaign.funding
              ? " Advisory matches work before funding; the market opens after funding."
              : ""}
          </p>
          <CreatorMatchesPanel campaignId={campaign.id} />
        </Card>
        <Card title="Participants">
          {participantRows.length ? (
            <ul className={styles.campaignList}>
              {participantRows.map((p) => (
                <li key={p.partnerId} className={styles.campaignRow} style={{ cursor: "default" }}>
                  <span className={styles.campaignName}>{p.label}</span>
                  <div className={styles.campaignMeta}>
                    <span className="tnum">
                      {p.funnel.clicks} visits · {p.funnel.conversions} actions · {p.funnel.verified} verified ·{" "}
                      {p.funnel.inHold} in hold · {p.funnel.settledOutcomes} settled ·{" "}
                      {formatUsdc(p.funnel.settledPayoutMicroUsdc)} USDC settled
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No participants yet" body="Creators who join this campaign appear here with their real funnel." />
          )}
        </Card>
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
